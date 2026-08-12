# ADR-07 — Local Daemon Bridge Protocol

## Status
Proposed

## Context

Phase 3 (Chapter 2 §2.3) adds an optional local companion daemon for out-of-browser hardware that Fugu cannot reach: raw serial, TCP/UNIX sockets, file watching beyond the File System Access sandbox, system stats, and NFC polling without a user gesture. The core package must behave **identically when the daemon is absent** (additive-only, §2.3).

Constraints at decision time:

- Browsers restrict WebSockets to the same port-origin rules only for *unsecure* contexts; a page served over `http://localhost` can open `ws://127.0.0.1:PORT` directly, so the daemon is connectable from local web pages without an extension — but this also means an arbitrary web page on evil.com cannot reach the daemon (Origin check required) while a page **we** serve on localhost can.
- The existing bridge (Chapter 5 §5.4 sketch) already commits to: `ws://127.0.0.1:<port>`, a `hello`/`advertise` handshake, a JSON request/response frame keyed by `cap`, heartbeats, and a per-capability permission gate (`ERR_PERMISSION_DENIED`). M3.1 must turn that sketch into a complete, versioned, testable wire spec without changing Phase 1/2 behavior.
- No credentials may travel on the wire (Chapter 7 §7.3: "Daemon wire protocol carries no secrets"); the daemon keeps its own store.
- Distribution (installer vs bundled) is out of core scope (Chapter 2 §2.6); core only needs a stable wire contract so a separately distributed daemon can interoperate.
- Fuzz gate (≥ 1 M malformed frames, §2.3) means the frame grammar must be closed and small enough to fuzz, but extensible per-capability.

## Decision

**Adopt a JSON-lines WebSocket protocol over `ws://127.0.0.1:47500` (default; overridable via `OxelotConfig.daemon.port`) as the normative daemon contract, specified in §5.4. Key points:**
- **Versioned envelope:** every WebSocket message carries `type` + `protocolVersion` (currently `1`). Received messages with an unsupported version are rejected with `ERR_DAEMON_VERSION`.
- **Handshake:** client sends `{type:'hello', app:'oxelot', protocolVersion:1, clientId}`; daemon replies `{type:'advertise', protocolVersion:1, caps:[...]}` advertising capability names with their `permission` requirement. No state mutation before `ready`.
- **Control vs capability frames:** `request`/`response`/`event` are capability-scoped (carry `cap`); `hello`/`advertise`/`ping`/`pong` are connection-scoped. Responses correlate by `id`; the client rejects unknown `id`s as schema violations.
- **Heartbeat:** `{type:'ping'}` every 15 s; `{type:'pong'}` expected within 5 s; two missed beats ⇒ connection reset and exponential backoff retry (§5.4.5).
- **Permission model:** per-capability, per-origin, consumer-driven. A capability with `permission:true` is only honoured after the consumer calls `daemon.grant(cap)` (requires a user gesture); otherwise `ERR_PERMISSION_DENIED`. Grants are session-scoped.
- **Origin check:** the daemon accepts only connections whose `Origin` header is a local http(s) origin (host `localhost`, `127.0.0.1`, or `[::1]`) or absent (non-browser clients). Pages on remote origins cannot reach it.
- **Additive default:** `features.daemon` is `false` by default; `Oxelot.hardware` and storage/sync behave identically when `daemon` is off or unreachable (`daemon:false` in `HardwareCapabilities`).
- **Distribution out of core:** this ADR and §5.4 define the wire contract only; the daemon binary is distributed separately (installer, not bundled — Chapter 2 §2.6).

## Consequences

**Positive (+):**
- The contract is closed (7 message types, fixed schema, one JSON object per frame) so it is easy to implement on both ends and fuzzable (M3.4 gate).
- Versioned envelope lets the pack and the daemon evolve independently (M3.3 adds capabilities without touching the core framing).
- Origin-gated localhost WebSocket keeps the additive model alive: a PWA on localhost can talk to the daemon with no browser extension, while remote pages are structurally excluded.
- Permissions are explicit and consumer-driven, matching the existing `acquire()` hardware flow ergonomics (`hardware.capabilities()` lists `daemon` when the bridge is `ready`).

**Negative (−):**
- WebSocket (not a message bus) means one long-lived connection per page; multiple tabs each connect (the daemon SHOULD multiplex, but core must tolerate per-tab sessions in M3.2).
- Per-origin, no-token trust is weaker than a pairing/token flow; acceptable while the daemon only exposes hardware and the connection is localhost-only behind an Origin check. Stronger device pairing is a later, additive hardening (NOT in the v1 contract).
- Grants are session-scoped: a page reload re-prompts. Deliberate for v1 (least surprise, matches permission UX); persists-grant across sessions is a possible enhancement.

**Neutral (~):**
- Default port 47500 is overridable per `OxelotConfig.daemon.port`; the well-known default is a convention, not a registration.
- Capability `schema` hints are informational (not normative validation); the daemon is the source of truth for its own request shapes.

## Alternatives considered
- **Chrome extension + native messaging** — rejected: breaks `ws://` additive model, requires extension distribution, and is overkill for localhost hardware.
- **WebRTC DataChannel only** — rejected: no server for the initial handshake without an SDP exchange; kept *only* as the fallback transport when the WebSocket endpoint never answers (§5.4.2).
- **HTTP(S) REST endpoint** — rejected: no natural push path for `event` frames (file watcher, stats) and slower bi-directional cadence; WebSocket gives one-duplex channel.
- **Bare TCP socket** — rejected: browsers cannot open raw TCP from pages; the daemon must still terminate a WebSocket.
- **Token/secret on the wire** — rejected: violates Chapter 7 §7.3; pairing tokens would expire and complicate the zero-secret property for no local win yet.