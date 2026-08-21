# Changelog

All notable changes to Oxelot are documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org/).

## [0.3.0] — Phase 3: Daemon bridge

### Added
- **Local daemon bridge (M3.2/M3.3, ADR-07):** `Oxelot.init({ daemon: { url } })` wires a `ws://127.0.0.1` client with state machine, heartbeat, exponential backoff, and WebRTC DataChannel fallback; capability registry (`serial`, `socket`, `file`, `sys`) with typed passthrough APIs; gesture-gated session grants (`daemon.grant(cap)`, `ERR_PERMISSION_DENIED` otherwise); `hardware.capabilities()` surfaces the daemon while ready. Additive-only — everything works identically without a daemon.
- **Daemon security boundary (M3.4):** localhost-only URL enforcement, handshake schema lock (frame-size cap, bounded identifiers), 1M-frame fuzz harness (`npm run fuzz:daemon`) proving malformed input never bypasses permissions.
- **Playground demo app:** tabbed UI (Smoke / Storage / Database / Sync / Hardware / Daemon) including serial passthrough read/write demo and graceful daemon-absent error paths.
- User guide §10.3.6 (daemon usage) added; docs updated for v0.3.0.

### Changed
- `docs/02`: all M3 exit criteria checked (fallback probe, wire-level auth round-trip, playground serial demo).

## [0.2.2] — Chunked sync queue

### Changed
- **Sync queue layout v2** (`PersistentSyncQueue`): manifest + ≤500-envelope chunks replace the single-array key. Enqueue and drain checkpoints now write O(chunk) instead of O(queue) bytes (previously ~n²/100 envelope rewrites per drain). Two-phase compaction is crash-safe; legacy arrays migrate transparently on first read; exactly-once by id, FIFO pop-on-success, checkpoint bounds, backoff, and dead letters unchanged.

## [0.2.1] — React stabilization

### Fixed
- **`useOxelotSyncStatus` never re-rendered**: `getSnapshot` returned a constant idle state. Now caches snapshots by value and seeds pending/dead-letter counts from the persisted queue on mount.
- **`useOxelotStorage.remove` sync parity**: mirrors `write()` — optimistic local removal plus a durable `delete` envelope (new additive `makeStorageMutation(key, value, { op: 'delete' })`), with rollback on failure.

### Added
- First React unit-test suite (18 tests over all four hooks) via `@testing-library/react` + jsdom; vitest resolves workspace source hermetically.

## [0.2.0] — Phase 2: Hardware & background

- M2.1 service-worker relay (`oxelot-sync` message relay, `sync`/`periodicsync` handlers, shared IndexedDB queue).
- M2.2 durable background-sync queue: envelope write-ahead, atomic pop-on-success, checkpointed drains, exponential backoff 30 s→1 h cap, dead letters, exactly-once by id.
- M2.3 Web Locks: blocking `oxelot-sync` flush serialization across tabs/SW; `oxelot-storage:<name>` write+read guard with ≤100 ms release invalidation.
- M2.4 periodic background sync (`features.periodicSync`, 12 h default min interval, no-op fallback).
- M2.5 Fugu hardware bridge: capability truth tables, native `acquire()` prompt mapping (`ERR_HW_GESTURE_REQUIRED`/`ERR_HW_DENIED`), wake-lock handle.
- D8 optimistic write→envelope in `useOxelotStorage.write`.

## [0.1.0] — Phase 1: Foundation & storage

- Monorepo scaffolding (npm workspaces); `@oxelot/core` facade, worker pool with crash respawn, OPFS + IndexedDB storage backends.
- WASM SQLite (`db.run/query/checkpoint`) via Rust crate compiled to `wasm32-wasip1` with zig; image-based persistence across reloads (ADR-05).
- Cross-tab `storage-change` events via BroadcastChannel (ADR-06).
- `@oxelot/react` hooks (`useOxelot`, `useOxelotStorage`, `useOxelotDB`).
- Performance gates wired into CI: G1 long-task, G2 OPFS soak, G3 round-trip p95 < 16 ms, G7 bundle ≤ 35 KB gzip + lazy WASM timing; B-1 no-DOM probes; dependency-cruiser framework gate.
