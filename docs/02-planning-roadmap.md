# 2. Planning & Roadmap (Milestone Driven)

**Chapter status:** Final (v0.1.0) · **File:** `docs/02-planning-roadmap.md`

---

## 2.0 Roadmap Philosophy

Three execution rules govern every phase. Violating them is a process defect:

1. **Strict ordering — no skipping.** Phase N+1 work may not begin until Phase N exit criteria pass (see §2.5). Rationale: each phase lays the substrate the next one stands on.
2. **Vertical slices, not horizontal layers.** Within a phase, work is done as end-to-end slices (e.g., "hook → bridge → worker → OPFS → SQLite"), so each milestone ships something *usable*, not just a pile of internal plumbing.
3. **Instrument before optimizing.** Every bridge records timing at first implementation. The 16ms budgets (G1/G3) are asserted from the first test run, not retrofitted.

Versions: v0.1.0 = Phase 1 · v0.2.0 = Phase 2 · v0.3.0 = Phase 3. Each phase ends in a **release candidate** that is documented and tagged.

---

## 2.1 Phase 1 — Foundation & Storage (MVP) → `v0.1.0`

**Theme:** a framework-agnostic core with OPFS-backed storage, worker threading, and React hooks.

### Milestone M1.1 — Monorepo scaffolding
**Deliverables:**
- Root `package.json` (workspace), `.npmrc`, `.gitignore`, `.editorconfig`.
- `packages/core` + `packages/react` workspaces.
- Build chain: `tsup` (ESM+CJS+d.ts), `vitest`, `eslint` (flat config, strict), `prettier`.
- Playwright harness with headless Chromium + `webServer` (vite playground).
- `npm` scripts: `build`, `build:wasm`, `test`, `test:e2e`, `lint`, `typecheck`.

### Milestone M1.2 — Worker pool + message bridge
**Deliverables:** `OxelotBridge` (typed `postMessage` RPC), `OxelotPool` (2–4 workers, FIFO, load tracking, worker-crash respawn), timing instrumentation.
**Slice:** `pool/` unit tests proving round-trip timing.

### Milestone M1.3 — OPFS wrapper
**Deliverables:** `OxelotFS` + `OxelotFile` implemented over `createSyncAccessHandle` (worker-only), byte-exact read/write/truncate/sync/close, and `IndexedDB` fallback implementing the identical interface.
**Slice:** storage round-trip test (write 10MB, reload page, verify bytes).

### Milestone M1.4 — WASM SQLite (OPFS VFS)
**Deliverables:** Rust crate `wasm/sqlite-vfs` compiled with wasm-pack to `wasm32-unknown-unknown`; lazy in-worker instantiation; `DatabaseFacade` with `exec`, `query`, `run`; WAL mode + checkpoint on close.
**Slice:** CRUD + persistence across page reload; `db.exec` timing under the G3 budget.
> Deviation (ADR-05): shipped with `wasm32-wasip1` + zig instead of wasm-pack/`wasm32-unknown-unknown`, image-based persistence via `serialize/deserialize` instead of a full OPFS VFS, all `db.*` ops pinned to worker 0. WAL is rejected (serialize only captures the main DB file).

### Milestone M1.5 — State sync primitive
**Deliverables:** Structured-clone + `Transferable` message protocol (specified in Chapter 6); storage watcher events (`event` messages); subscription API.
**Slice:** two tabs via Playwright contexts; writes in tab A propagate to tab B within 100ms.

### Milestone M1.6 — Facade + React hooks
**Deliverables:** `Oxelot.init(config)`, `useOxelot`, `useOxelotStorage`, `useOxelotDB`, `useOxelotSyncStatus` (sync hook is a thin status placeholder in Phase 1).
**Slice:** a Vite playground app exercising all hooks.

### M1 Exit Criteria (Phase 1 gate)
- [x] G1: no long tasks > 16ms during the 30s heavy workload — `perf.yml` (nightly + manual) green.
- [ ] G2: 500MB OPFS dataset written/reloaded/read byte-identical — 5MB Chrome CI (`opfs`) green; 500MB (`@g2-full`) + Safari 15.2+ = manual.
- [x] G3: round-trip p95 < 16ms in CI — asserted in `smoke.spec.ts` (Chromium).
- [x] G5: ESLint B-1 rule (no DOM in core) + bootstrap probe green.
- [x] G6: dependency-cruiser passes (no framework in core) — in CI quality job.
- [ ] G7: core ≤ 35KB gzip (CI size gate green); WASM ready ≤ 100ms — desktop bound asserted in e2e; mid-tier Android is manual (§8.4.4), pending.
- [x] All unit + e2e tests green on Chromium; OPFS Safari tests pending the manual matrix.

---

## 2.2 Phase 2 — Hardware & Background Layer → `v0.2.0`

**Theme:** durable offline mutation delivery + hardware capability bridge.

### Milestone M2.1 — Service worker relay
**Deliverables:** `sw.ts` registered by `Oxelot.init` (or consumer-controlled register option), message relay between SW and pages, `sync` event listener stub.

### Milestone M2.2 — Background Sync queue
**Deliverables:** `/sync/queue.ts` (`enqueue`, `flush`, `peek`, state machine), envelope persistence to OPFS/IDB before any network I/O, exponential backoff (30s→1m→5m→1h cap), dead-letter quarantine, `SyncState` events.
**Slice:** offline-enqueue 100k envelopes, restore network, assert ≥99% delivered exactly-once within the 24h soak window (G4).

### Milestone M2.3 — Web Locks integration
**Deliverables:** Web Locks-based exclusive sync (`oxelot-sync` lock, blocking), storage-write serialization across tabs (`oxelot-storage:<name>` write+read guard), lock-release-driven cache invalidation (≤100 ms).
**Slice:** two-context contention test — exactly one flusher active (page + SW + two tabs).

### Milestone M2.4 — Periodic Background Sync
**Deliverables:** `periodicsync` registration where supported; graceful no-op fallback; surfacing of capability to consumers.
**Slice:** 4.1 registration (`features.periodicSync`, default 12 h) + SW `periodicsync` fire path; 4.2 `syncCapabilities()` truth table — docs/11 Phase 4. ✅ slices 4.1–4.2; real periodic firing is manual-matrix (Ch. 8 §8.4).

### Milestone M2.5 — Fugu hardware bridge (`/hardware`)
**Deliverables:** capability detection (`HardwareCapabilities`), wrappers for Web NFC/USB/Bluetooth/Wake Lock/File System Access, stub fallbacks, permission request flow (`acquire`).
**Slice:** `capabilities()` truth table tests across 3 browser profiles; manual NFC/USB matrix. ✅ slices 5.1–5.2 (`hardware.test.ts` mapping truth table; `hardware.spec.ts` green on Chromium+WebKit+Firefox via `PW_MATRIX=1`); native permission prompts themselves are the manual NFC/USB matrix (Ch. 8 §8.4).

### M2 Exit Criteria
- [x] G4 soak test green (@perf e2e: 100k offline backlog drained exactly-once in 5.5 m, zero dead letters).
- [x] Cross-tab lock correctness under Playwright multi-context (web-locks.spec.ts 3.1–3.3: storage write guard, release→invalidation ≤100 ms, exactly one active flusher).
- [x] Capability detection matches expected truth table on Chromium/Firefox/WebKit (`hardware.spec.ts` 5.2: 6/6 across all three engines via `PW_MATRIX=1`; `syncCapabilities()` parity on Chromium e2e — periodic-sync.spec.ts 4.1).
- [x] No regression on M1 criteria (full suite re-run: unit 87, e2e default 21, @perf G1/G4/1.4, lint/typecheck/depcruise/size — all green at v0.2.0 gate).

---

## 2.3 Phase 3 — Daemon / Advanced Bridge (Optional) → `v0.3.0`

**Theme:** optional local companion daemon for hardware beyond Fugu. **Additive only** — core must behave identically with the daemon absent.

### Milestone M3.1 — Daemon wire spec
**Deliverables:** protocol spec document (`ws://127.0.0.1:<port>`), handshake, capability advertisement frame, heartbeat interval, message frame layout (see §5.4.3). Versioned (`protocolVersion: 1`).
**Slice:** M3.1 ✅ kickoff 2026-08-13 — wire spec in Chapter 5 §5.4 (v1) + [ADR-07](04-ADR/07-daemon-bridge-protocol.md); M3.2–M3.4 pending.

### Milestone M3.2 — Transport layer
**Deliverables:** WebSocket primary transport, WebRTC DataChannel fallback (port conflict/drop), connection state machine (`disconnected → connecting → handshake → ready`), auto-retry with backoff.

### Milestone M3.3 — Daemon capability registry
**Deliverables:** registry + examples: USB-serial passthrough, raw TCP/UNIX socket relay, file watcher, system stats. Each capability: request/response schema, permission flag, error codes.

### Milestone M3.4 — Security boundary
**Deliverables:** localhost-origin verification, per-capability permission handshake (consumer must opt-in per capability), message schema validation on both ends, secret-free wire protocol, fuzz harness for malformed frames.

### M3 Exit Criteria
- [ ] Fuzzing run (≥ 1M malformed frames) yields no memory issues and no unauthorized capability access.
- [ ] Fallback: with daemon absent, all Phase 1+2 features pass unchanged.
- [ ] Auth round-trip test: unauthorized frame rejected with `ERR_PERMISSION_DENIED`.
- [ ] Optional-criteria demo: serial passthrough read/write in the playground.

---

## 2.4 Execution Strategy (cross-cutting)

1. **TDD discipline.** Every module ships with its tests in the same PR; `test` and `test:e2e` are CI-mandatory.
2. **Feature flags.** `OxelotConfig.features?: { daemon?: boolean; periodicSync?: boolean }` — flags default off; documented in Chapter 5 §5.5.
3. **Performance CI gate.** The long-task monitor and round-trip timing assertions run on every PR, not only at milestones.
4. **ADR-gated API changes.** Any public surface change creates an ADR before implementation (Chapter 4, B-4).
5. **Backwards-compatible defaults.** New capabilities are opt-in; `storageBackend: 'auto'` keeps resolving to the best available backend.

### 2.4.1 Dependency graph between milestones

```
M1.1 ─► M1.2 ─► M1.3 ─► M1.4 ─► M1.5 ─► M1.6  (Phase 1)
          │       │       │
          ▼       ▼       ▼
M2.1 ─► M2.2 ─► M2.3 ─► M2.4 ─► M2.5           (Phase 2; all depend on M1 pool+bridge)
          │
          ▼
M3.1 ─► M3.2 ─► M3.3 ─► M3.4                   (Phase 3; depends on M2.5 transport + M1.5 events)
```

Arrows = hard prerequisite. Nothing consumes a milestone that has not reached its exit criteria.

---

## 2.5 Release & Verification Procedure

For each phase release `vX.Y.0`:
1. Freeze the API surface; run `api-extractor`-style review of exported types (Chapter 5 contracts as the checklist).
2. Run the full test matrix: unit, integration, e2e, performance gate, bundle-size gate.
3. Tag and publish `@oxelot/core` then `@oxelot/react` (core first, because react depends on core).
4. Write the phase's "Known limitations" appendix (e.g., Safari OPFS coverage, Play Integrity irrelevance note).
5. Update the README checkboxes (§ Repository Status).

---

## 2.6 Open questions to resolve at each kickoff

| Phase | Open question | Default if unresolved |
|-------|--------------|----------------------|
| 1 | Min Node version (20 vs 22) | **Resolved → Node ≥ 22** (CI runs on 22; dependency-cruiser requires `^22||^24||>=26`) |
| 1 | Worker count default (2 vs 4) | 2 (configurable) |
| 2 | Sync endpoint schema versioning | Envelope gains `schemaVersion: 1` |
| 3 | Daemon distribution (installer vs bundled) | Documented; installer out of core scope |

Decisions must be recorded as ADR entries when they change a public contract.
