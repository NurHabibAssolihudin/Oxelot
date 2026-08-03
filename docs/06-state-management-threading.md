# 6. State Management & Threading Model

**Chapter status:** Final (v0.1.0) · **File:** `docs/06-state-management-threading.md`

---

## 6.1 Threading Topology (canonical)

```
Main Thread (UI / consumer framework)
   ▲                                        ▲
   │ promises (never callbacks-only,        │ 'storage-change' / 'sync-state' /
   │ never synchronous across threads)      │ 'worker-error' events
   │                                        │
   ▼                                        │
OxelotBridge (postMessage RPC, correlation) │
   │                                        │
   ▼                                        │
OxelotPool ── Worker[0] ── Worker[1] ── …   │
   │  each worker: OPFS sync handle +       │
   │  WASM SQLite + mutation queue replay   │
   ▼                                        │
OPFS / IndexedDB ───────────────────────────┘ (watchers emit events)
```

**Rules (normative, enforced in review + tests):**
1. **No synchronous call crosses a thread boundary.** All worker interactions are promises.
2. **No heavy work runs on the main thread.** OPFS sync handles, SQLite, queue replay, and envelope serialization run exclusively in workers.
3. **The main thread only:** receives typed requests/results, fans out events, and lets the consumer framework render.
4. **Exactly one storage writer per file at a time**, guaranteed by Web Locks (§6.3.5).

---

## 6.2 Message Protocol (`OxelotBridge`)

### 6.2.1 Wire messages (normative)

```ts
export type OxelotMessage =
  | { kind: 'request'; id: string; op: string; payload?: unknown; transfer?: ArrayBuffer[] }
  | { kind: 'response'; id: string; ok: true; result?: unknown }
  | { kind: 'response'; id: string; ok: false; error: { code: string; message: string } }
  | { kind: 'event'; name: string; payload?: unknown }
```

### 6.2.2 Semantics

- **`request`:** main → worker. `id` is a monotonic counter per bridge (`String(nextId++)`). `op` routes to the worker-side registry (Chapter 9 §9.3). Binary payloads listed in `transfer` are moved **zero-copy** (detached from sender).
- **`response`:** worker → main. Matches `id` against the pending `Map<id, {resolve,reject}>`. Unknown `id` is ignored.
- **`event`:** worker → main *push* (no correlation). Carries watcher notifications (`storage-change`) and sync progress (`sync-state`). Main thread fans out to `Oxelot.on()` subscribers.
- **`config` op (ADR-04):** a `request` sent by the pool to each worker at start, before the worker is marked available. Payload `{ dbName?, storageBackend?, dbEnabled? }`. Not a new message kind — it routes through the existing registry.
- **Timeouts:** default `ERR_BRIDGE_TIMEOUT` after 10s for `request`s; configurable via `OxelotConfig.bridgeTimeoutMs` (not part of the public config in v1 — internal constant, documented here for implementers).

### 6.2.3 Zero-copy rule
- `Uint8Array`/`ArrayBuffer` payloads **must** use `transfer`; never structured-clone a buffer across the boundary (violates G3).
- After transfer, the sender's buffer is detached — callers must not reuse it.

### 6.2.4 Bridge API (normative)

```ts
// core/pool/bridge.ts
export class OxelotBridge {
  request<T>(op: string, payload?: unknown, transfer: ArrayBuffer[] = []): Promise<T>
  onEvent(cb: (name: string, payload?: unknown) => void): () => void
  readonly pending: number   // in-flight request count (load metric input)
}
```

---

## 6.3 Offline-First Synchronization Without DOM Freeze

The goal: mutations made offline are durable, delivered later, and the UI never blocks on any of it.

### 6.3.1 Flow overview

```
Consumer write ─► useOxelotStorage().write(value)
        │
        ▼
Optimistic local apply (state updates immediately, resolve promise)
        │
        ▼
Core creates envelope (id, collection, op, payload, createdAt)
        │
        ▼
enqueue() → persist to OPFS/IDB (write-ahead) ──► resolves only after durable write
        │
        ▼
Browser offline?  ── no ──► flush() immediately (acquire 'oxelot-sync' lock)
        │
      yes
        ▼
Queue waits; SW 'sync' event on connectivity restore triggers flush()
```

### 6.3.2 Optimistic writes
- The hook applies `value` to its local state **before** any storage/network I/O; `write()` resolves immediately from the consumer's perspective.
- Durability is guaranteed separately: if the persisted `enqueue` fails (e.g., quota), the hook emits `error` and rolls back the optimistic value (via a second `storage-change` event).

### 6.3.3 Backpressure
- `OxelotPool` exposes `load(): number` = `pending / (workers * concurrencyPerWorker)`.
- When `load > 0.8`, hooks defer new writes by one microtask and notify consumers via `worker-error`? **No** — via a new event `{ type: 'backpressure'; load }`. (Not in v1 public contract; internal only. Hooks surface nothing; the queue absorbs pressure.)
- Scheduler avoids scheduling new work when `load > 0.9`.

### 6.3.4 Durability ordering (normative invariant)
`enqueue()` resolves **only after** the envelope is durably persisted. Therefore:
- Crash between local apply and `enqueue()`: the optimistic value may be lost — acceptable and documented (consumer may prefer `await write()` for critical data).
- Crash after `enqueue()`: envelope survives; SW replays on reconnect. No data-loss window between persistence and replay.

### 6.3.5 Cross-tab consistency with Web Locks
- Storage writes acquire `oxelot-storage:<file>` (or `oxelot-storage:<key>` for `StorageFacade.set`) with `ifAvailable: true`; on lock-unavailable the write is queued behind the lock holder (non-blocking main thread).
- Sync flush acquires `oxelot-sync`; only one tab/SW flushes at a time (exactly-once intent, §5.2.5).
- On lock release, listeners in other tabs receive `storage-change` and invalidate caches; Playwright two-context test asserts propagation ≤ 100ms (M1.5).

### 6.3.6 UI-thread guarantee
- All of §6.3 executes in workers; the main thread's work per mutation is: optimistic state update (µs), `postMessage` (µs), and promise resolution — well under the 16ms budget (G1).
- The performance CI gate (Chapter 2 §2.4, Chapter 8 §8.4) measures long tasks during the scripted 30s workload.

---

## 6.4 Worker lifecycle

| Event | Behavior |
|-------|----------|
| Spawn | `Oxelot.init` creates `workers` workers with the bundled `worker.js`, broadcasts `op: 'config'` (dbName/backend/dbEnabled, ADR-04), then each runs self-test on boot (OPFS availability probe) |
| Crash / `error` | Pool marks it dead, respawns, re-dispatches in-flight requests once (`attempts=1`), then rejects with `ERR_WORKER_SPAWN`/`ERR_BRIDGE_TIMEOUT` |
| Idle | Workers never terminated while pool alive (avoids re-init cost of WASM SQLite); `dispose()` terminates all |
| Dispose | `Oxelot.dispose()`: terminate workers, close sync handles, release `oxelot-sync`/`oxelot-storage:*` locks, remove listeners |

---

## 6.5 Event fan-out (main thread)

`Oxelot.on(cb)` receives `OxelotEvent` (§5.5.4). Guarantees:
- Events are delivered asynchronously (never re-entrant during a `postMessage` handler).
- Subscribers may unsubscribe via the returned disposer; subscription is idempotent.
- `ready` fires once after `init` completes (workers spawned, storage backend selected).
