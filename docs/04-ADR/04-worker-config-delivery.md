# ADR-04 — Deliver Worker Configuration over the Existing Request/Response Bridge

## Status
Accepted

## Context

`OxelotConfig` (Chapter 5 §5.5.1) exposes `dbName`, `storageBackend`, and `dbEnabled`, but none of them reach the worker:

- `worker-entry.ts` listens for a bespoke `kind: 'config'` message that **no code sends**, so `DB_NAME` is stuck at the hard-coded `'oxelot.db'` and `OxelotConfig.dbName` is silently ignored.
- The storage facade is created eagerly at worker boot with a hard-coded `'auto'` backend; `OxelotConfig.storageBackend` is never honored.
- `dbEnabled` is declared in the config type but has no defined behavior in either the code or the spec.

The wire protocol (Chapter 6 §6.2.1) defines exactly three message kinds — `request`, `response`, `event` — and a registry of `op` strings dispatched on the worker side. Constraints at decision time:

- Adding a fourth message kind would diverge from the documented protocol and complicate both `bridge.ts` and `worker-handler.ts`.
- Configuration must be applied **before any request is dispatched**, or `dbName`/`backend` could race with `db.*` and `storage.*` requests.
- The protocol is version-skewed across releases; any new element should degrade gracefully rather than crash old workers.

## Decision

**Deliver worker configuration through the existing request/response bridge as a new `op: 'config'`, broadcast once at pool start.**

- `OxelotPool.start(config?: WorkerInitConfig)` spawns each worker, then awaits a `request('config', { dbName, storageBackend, dbEnabled })` on **every** bridge **before** that worker is marked available. No request can be dispatched before its worker is configured.
- `WorkerInitConfig = { dbName?: string; storageBackend?: StorageBackend; dbEnabled?: boolean }`. Unset fields are omitted; the worker keeps defaults (`'oxelot.db'`, `'auto'`, `true`).
- `worker-entry.ts` registers the `'config'` op in the handler registry and **removes** the dead top-level `kind: 'config'` listener.
- Storage is created **lazily** on first use with the configured backend (default `'auto'`), instead of eagerly at worker boot. This removes the ordering dependency between boot and config.
- **`dbEnabled: false` semantics:** `DatabaseFacade.run/query/exec` reject with the new error code `ERR_DB_DISABLED`. This is checked in `PooledDatabase` (main thread) before any request crosses the bridge.

## Consequences

**Positive (+):**
- `OxelotConfig.dbName`, `storageBackend`, and `dbEnabled` finally work as specified (Chapter 5 §5.5.1).
- No protocol change: `config` is just another op in the existing registry; `bridge.ts`, `worker-handler.ts`, and the wire messages stay exactly as Chapter 6 §6.2 documents.
- Lazy storage creation matches the lazy-instantiation philosophy used for WASM SQLite (§5.1.4) and removes boot-time ordering bugs.
- `ERR_DB_DISABLED` is additive and backward compatible.

**Negative (−):**
- Old workers (previous release) will reply `ERR_UNKNOWN` to an unknown `op: 'config'`; `start()` must treat that as an environment mismatch. Core and worker ship as a single unit (`dist/worker.js` bundled by tsup), so this is self-inflicted only during dev with stale build artifacts.
- `start()` now does N round-trips (one per worker) before the pool reports ready; negligible at pool sizes 1–8 but worth noting in the G3 timing budget.

**Neutral (~):**
- `dbEnabled: true` keeps current behavior (lazy WASM init on first `db.*` request).

## Alternatives considered
- **New `config` message kind** — rejected: diverges from the documented three-kind protocol and duplicates routing logic already present in the registry.
- **Embed config in every request payload** — rejected: wasteful per-message overhead and racy (a request may arrive before config).
- **`Oxelot.init` sends config through `postMessage` outside the bridge** — rejected: that is exactly the dead `kind: 'config'` path being removed; bypasses the bridge's timeout/correlation guarantees.
- **Keep eager storage creation and pass backend only on first open** — rejected: more surface area than a single `WorkerInitConfig`; lazy creation is simpler and uniformly correct.
