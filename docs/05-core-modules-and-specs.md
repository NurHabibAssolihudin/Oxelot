# 5. Core Modules & Technical Specifications

**Chapter status:** Final (v0.1.0) · **File:** `docs/05-core-modules-and-specs.md`

This chapter is the **contract**. Every type below is a normative specification: the implementation must expose exactly these names, signatures, and semantics. Any deviation requires an ADR (Chapter 4).

Source layout this chapter specifies:

```
packages/core/src/
├── core/
│   ├── storage/          # Module 1
│   ├── sync/             # Module 2
│   ├── hardware/         # Module 3
│   ├── pool/             # worker pool + bridge (Chapter 6)
│   └── index.ts          # Oxelot facade (public entry)
packages/react/src/       # React hooks (bindings only)
wasm/sqlite-vfs/          # Rust crate → wasm32
```

---

## 5.1 Module 1 — Storage Engine (`/storage`)

### 5.1.1 Files

| File | Responsibility |
|------|----------------|
| `opfs.ts` | `OpfsStorage`, `OpfsFile` over `createSyncAccessHandle` |
| `idb.ts` | `IdbStorage`, `IdbFile` over IndexedDB (same `StorageProvider` interface) |
| `index.ts` | `createStorage(config)` selection factory |
| `types.ts` | `StorageProvider`, `OxelotFile` interface + `createSyncAccessHandle` shim |

### 5.1.2 Public types (normative)

```ts
// storage/index.ts
export type StorageBackend = 'opfs' | 'indexeddb' | 'auto'

export interface OxelotFile {
  /** Current size in bytes. */
  size(): Promise<number>
  /** Read `length` bytes starting at `offset`; shorter array if at EOF. */
  readBytes(offset: number, length: number): Promise<Uint8Array>
  /** Write `data` at `offset`, growing the file as needed. */
  writeBytes(offset: number, data: Uint8Array): Promise<void>
  /** Truncate or extend the file to `size` bytes. */
  truncate(size: number): Promise<void>
  /** Flush to durable storage (no-op for idb backend). */
  sync(): Promise<void>
  close(): Promise<void>
}

export interface StorageProvider {
  readonly backend: StorageBackend
  open(name: string, mode: 'read' | 'readwrite'): Promise<OxelotFile>
  remove(name: string): Promise<void>
  entries(): Promise<string[]>
  /** True when backend is usable in this environment. */
  isSupported(): boolean
}
```

### 5.1.3 Semantics (normative)

| Behavior | OPFS | IndexedDB |
|----------|------|-----------|
| Open | `getDirectory()` → `getFileHandle(name,{create})` → `createSyncAccessHandle()` | IDB object store `files`, keyed by name; one `OxelotFile` = one row of `Uint8Array` chunks |
| Must run in | Worker only (sync handles) | Any thread |
| `readBytes` | `handle.read(buffer, { at: offset })` (clamp to size) | Slice concatenated chunks for `[offset, offset+length)` |
| `writeBytes` | `handle.write(data, { at: offset })`; grow via auto-extend | Store split into ≤ 1 MiB chunks; rewrite touched chunks |
| `truncate` | `handle.truncate(size)` | Cut chunk list; drop trailing chunks |
| `sync` | `handle.flush()` | No-op (IDB is already transactional) |
| `close` | `handle.close()` | Release row cache |
| Errors | `throw OXELOT_ERR` codes from §5.6 | same |

### 5.1.4 WASM SQLite + OPFS interaction (canonical flow)

> **Amendment (ADR-05):** M1.4 ships the *interim* flow below — image-based
> persistence via `sqlite3_serialize`/`deserialize` — because a full OPFS VFS is
> a large FFI surface. The VFS flow (end-state) is retained as the documented
> target in §5.1.4.

**Interim flow (implemented):**

1. `Oxelot.init` broadcasts `op: 'config'` to every worker at pool start (ADR-04). `DB_NAME` and backend reach the worker before any request.
2. First `db.*` op on the worker lazily loads the `.wasm` (target `wasm32-wasip1`, plain extern-C ABI, no `wasm-bindgen`), seeds it from the persisted image file `{DB_NAME}.sqlite` (deserialize), or starts empty if none exists.
3. `db.run`/`db.query` execute against the in-memory connection. After each `db.run`, the worker serializes the whole image (`export_db`) and writes it back to the OPFS file (truncate → write → sync). `db.checkpoint` forces a persist without running SQL.
4. `init` runs with `journal_mode = DELETE`, `synchronous = NORMAL` — serialize captures only the main DB file, so a WAL journal must never be left behind.
5. All `db.*` ops are pinned to worker 0 (`PoolRequestOptions.worker`); SQLite is a single in-memory instance and the pool must not round-robin it.

**End-state VFS flow (target, per original spec):**

1. Worker `W` initializes OPFS dir handle for origin; opens file `DB_NAME` (`{ create: true }`).
2. `W` creates a sync access handle; passes it to WASM glue via the VFS interface.
3. SQLite VFS calls `xOpen/xRead/xWrite/xSync/xTruncate/xFileSize` against the handle — **all inside `W`**, never on main thread.
4. DB opened in `WAL` mode, `synchronous=NORMAL`; auto-checkpoint on `close`.
5. `db` sub-facade serializes SQL requests into the pool with the `op: 'db.exec'` family (Chapter 6).

```rust
// wasm/sqlite-vfs/src/vfs.rs (conceptual; FFI boundary)
// xRead(offset, len)  -> handle.read(&mut buf, at: offset)
// xWrite(offset, buf) -> handle.write(buf, at: offset)
// xSync              -> handle.flush()
// xTruncate(n)       -> handle.truncate(n)
// xFileSize          -> handle.getSize()
```

### 5.1.5 Selection factory

```ts
export async function createStorage(config: OxelotConfig): Promise<StorageProvider> {
  const want = config.storageBackend ?? 'auto'
  if (want === 'opfs') {
    if (!isWorkerScope()) throw oxError('ERR_OPFS_MAIN_THREAD')
    if (!OpfsStorage.isSupported()) throw oxError('ERR_OPFS_UNSUPPORTED')
    return new OpfsStorage()
  }
  if (want === 'indexeddb') return new IdbStorage()
  // auto
  return isWorkerScope() && OpfsStorage.isSupported() ? new OpfsStorage() : new IdbStorage()
}
```

---

## 5.2 Module 2 — Background Sync (`/sync`)

### 5.2.1 Files

| File | Responsibility |
|------|----------------|
| `envelope.ts` | `OxelotMutation` type + `serialize/deserialize` (versioned) |
| `queue.ts` | Persistence, enqueue/dequeue, state machine, dead letters |
| `scheduler.ts` | Retry/backoff schedule (30s→1m→5m→1h cap) |
| `web-lock.ts` | Exclusive `oxelot-sync` lock wrapper |

### 5.2.2 Envelope (normative)

```ts
// sync/envelope.ts
export interface OxelotMutation {
  /** UUIDv4, generated by core. Stable across retries. */
  id: string
  schemaVersion: 1
  /** Consumer-defined collection/table name. */
  collection: string
  op: 'upsert' | 'delete'
  /** Structured-cloneable payload. */
  payload: unknown
  createdAt: number          // epoch ms
  attempts: number           // increments on each replay attempt
  lastError?: string         // last failure message (dead-letter diagnostics)
}
```

Serialization: `JSON.stringify` for metadata + `payload` kept structured-clone-able (no functions, no `undefined` values — normalized to `null`). `schemaVersion` guards future migrations.

### 5.2.3 Queue API (normative)

```ts
export type SyncState =
  | { kind: 'idle' }
  | { kind: 'queued'; pending: number }
  | { kind: 'syncing'; pending: number }
  | { kind: 'dead_letter'; pending: number; deadLetters: number }

export interface SyncService {
  /** Persist an envelope BEFORE returning. Throws on write failure. */
  enqueue(m: OxelotMutation): Promise<void>
  /** Drain the queue: deliverable attempts, backoff for transient failures. */
  flush(): Promise<{ delivered: number; deadLetters: number }>
  /** Count pending + dead-letter. */
  status(): Promise<{ pending: number; deadLetters: number }>
  onStateChange(cb: (s: SyncState) => void): () => void
}
```

### 5.2.4 State machine (normative)

```
 enqueue()      connectivity restore (SW 'sync' event / explicit flush())
   ▼                         ▼
[PERSISTED] ──────────► [FLUSHING] ──► deliver ok ──► [DELIVERED] (delete from queue)
    │                        │  ▲
    │                        ▼  │ transient failure
    │                 [BACKOFF: attempts++ → schedule at
    │                  min(30s·2^(attempts-1), 1h)]
    │                        │  attempts ≥ 5
    │                        ▼
    │                 [DEAD_LETTER] (kept for diagnostics)
    ▼
```

- Delivery: `POST ${sync.serverUrl}` with JSON `{ schemaVersion, id, collection, op, payload }`; consumer acknowledges with HTTP `2xx`.
- Transient = network error or HTTP `5xx`/`429` (with `Retry-After` respected when present).
- Permanent = HTTP `4xx` (except `408`/`429`) or schema error → dead letter.
- Backoff schedule: attempt `1→30s`, `2→1m`, `3→5m`, `4→30m`, `5+→1h` (cap). `attempts` persists across page loads (stored with the envelope).

### 5.2.5 Web Locks integration (normative)

- All flush work acquires the named lock `oxelot-sync` with `ifAvailable: true`.
- Lock not available ⇒ another tab/SW is flushing; exit gracefully (no concurrent drain).
- Storage writes across tabs acquire `oxelot-storage:<file>` locks; `release` events trigger cache invalidation in other tabs (Chapter 6 §6.3.5).
- Lock timeouts: 30s max; release via `finally`.

### 5.2.6 Service worker contract

`sw.ts` (consumer-registered, or registered by `Oxelot.init` when `registerSW: true`):
- Listens for `sync` events; calls `sync.flush()`.
- Listens for `message` (`type: 'oxelot-sync'`) to trigger an explicit flush from a tab.
- Never touches DOM (SW has none). Uses the same `SyncService` module (bundled into the SW build via the pool's SW variant).

---

## 5.3 Module 3 — Hardware Bridge (`/hardware`)

### 5.3.1 Capability table (normative)

| Capability | Detection | Primary API | Fallback |
|-----------|-----------|-------------|----------|
| `nfc` | `'NDEFReader' in window` | Web NFC (`NDEFReader`) | Reject with `ERR_HW_UNSUPPORTED`; hint to install daemon |
| `usb` | `'USB' in navigator` | WebUSB (`navigator.usb.requestDevice`) | `<input type="file">` for file-transfer equivalent; daemon serial |
| `bluetooth` | `'bluetooth' in navigator` | Web Bluetooth (`navigator.bluetooth`) | Daemon |
| `wakeLock` | `'wakeLock' in navigator` | Wake Lock (`navigator.wakeLock.request('screen')`) | No-op stub + `warn()` once |
| `fileSystemAccess` | `'showOpenFilePicker' in window` | File System Access | `<input type="file">` |
| `vibration` | `'vibrate' in navigator` | Vibration API | No-op stub |
| `daemon` | detected at Phase 3 (§5.4) | WebSocket transport | absent |

### 5.3.2 API (normative)

```ts
// hardware/index.ts
export type HardwareCapability = keyof HardwareCapabilities

export interface HardwareCapabilities {
  nfc: boolean
  usb: boolean
  bluetooth: boolean
  wakeLock: boolean
  fileSystemAccess: boolean
  vibration: boolean
  daemon: boolean
}

export interface HardwareBridge {
  /** Snapshot; re-evaluated lazily, never cached across sessions. */
  capabilities(): Promise<HardwareCapabilities>
  isAvailable(cap: HardwareCapability): boolean
  /**
   * Request the user gesture-gated permission.
   * Rejects with ERR_HW_DENIED on refusal.
   */
  acquire(cap: HardwareCapability): Promise<void>
  /** Release (e.g., Wake Lock). No-op for unmanaged caps. */
  release(cap: HardwareCapability): Promise<void>
}
```

### 5.3.3 Permission flow
`acquire` maps to the API's native prompt (e.g., WebUSB `requestDevice`). All `acquire` calls require a user gesture; `isAvailable` does **not** imply permission granted. Rejection codes: `ERR_HW_DENIED`, `ERR_HW_UNSUPPORTED`, `ERR_HW_GESTURE_REQUIRED`.

---

## 5.4 Module 3b — Daemon Bridge (Phase 3, optional)

### 5.4.1 Purpose
Out-of-browser hardware access (raw serial, sockets, file watchers) that Fugu cannot provide. Additive: core works identically without it.

### 5.4.2 Transport
- Primary: `ws://127.0.0.1:<port>` (default port advertised via a well-known default, overridable in `OxelotConfig.daemon.port`).
- Fallback: WebRTC DataChannel (negotiated manually) when the WebSocket handshake times out (>2s).
- Heartbeat: JSON `{type:'ping'}` every 15s; `{type:'pong'}` expected within 5s; 2 missed ⇒ connection reset with backoff.

### 5.4.3 Frame layout (normative, v1)

```ts
interface DaemonFrame {
  v: 1                      // protocol version
  id: string                // request correlation id
  cap: string               // capability name, e.g. 'serial:read'
  ok?: boolean              // present on responses
  data?: unknown            // request params / response payload
  error?: { code: string; message: string }
}
```

### 5.4.4 Security boundary (normative)
1. Connect only to `127.0.0.1` / `[::1]`; reject any other host.
2. Handshake: client sends `{type:'hello', app:'oxelot', v:1}`; daemon replies with capability list; both sides validate schema.
3. Per-capability permission: consumer must call `daemon.grant(cap)` (requires user gesture) before any `cap` frame is honored; otherwise `ERR_PERMISSION_DENIED`.
4. No credentials/tokens on the wire; secrets stay in the daemon's own store.
5. Fuzz target: ≥ 1M malformed frames must not crash the daemon nor bypass permissions (Phase 3 exit criteria, Chapter 2 §2.3).

---

## 5.5 Core Facade & Config (normative)

### 5.5.1 Config

```ts
// core/index.ts
export interface SyncConfig {
  serverUrl: string
  /** Backoff multiplier between attempts (default 2). */
  backoffMultiplier?: number
  /** Cap for retry delay in ms (default 3_600_000). */
  maxBackoffMs?: number
}

export interface OxelotConfig {
  /** Worker pool size (default 2, min 1, max 8). */
  workers?: number
  /** SQLite DB file name (default 'oxelot.db'). */
  dbName?: string
  /** Disable the SQLite sub-facade: run/query/exec reject with ERR_DB_DISABLED. Lazy init skipped (default true). */
  dbEnabled?: boolean
  storageBackend?: StorageBackend
  sync?: SyncConfig
  /** Register the bundled service worker when true (default false). */
  registerSW?: boolean
  features?: {
    daemon?: boolean          // Phase 3
    periodicSync?: boolean    // Phase 2.4
  }
}
```

### 5.5.2 Facade

```ts
export class Oxelot {
  static init(config?: OxelotConfig): Promise<Oxelot>
  readonly storage: StorageFacade
  readonly db: DatabaseFacade
  readonly sync: SyncFacade
  readonly hardware: HardwareBridge
  readonly pool: OxelotPool
  /** Subscribe to core events (storage watchers, sync state, worker errors). */
  on(cb: (ev: OxelotEvent) => void): () => void
  /** Dispose: terminate workers, close handles, release locks. Idempotent. */
  dispose(): Promise<void>
}
```

### 5.5.3 Sub-facades (normative)

```ts
export interface StorageFacade {
  readonly backend: StorageBackend
  open(name: string, mode?: 'read' | 'readwrite'): Promise<OxelotFile>
  remove(name: string): Promise<void>
  entries(): Promise<string[]>
  /** Structured-keyed convenience over the same backend. */
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
}

export interface DatabaseFacade {
  /** Run a statement with no result set (INSERT/UPDATE/DDL). */
  run(sql: string, params?: unknown[]): Promise<void>
  /** Run a query; returns rows as objects. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  /** Prepare, execute, and return the first row or null. */
  exec<T>(sql: string, params?: unknown[]): Promise<T | null>
  /** Raw byte access to the DB file (via StorageFacade.open(dbName)). */
  checkpoint(): Promise<void>
}

export type SyncFacade = SyncService
```

### 5.5.4 Events

```ts
export type OxelotEvent =
  | { type: 'storage-change'; key: string; sourceTab: string }
  | { type: 'sync-state'; state: SyncState }
  | { type: 'worker-error'; worker: number; message: string }
  | { type: 'ready' }
```

---

## 5.6 Error codes (normative)

| Code | Meaning |
|------|---------|
| `ERR_OPFS_MAIN_THREAD` | OPFS sync handle requested on the main thread |
| `ERR_OPFS_UNSUPPORTED` | OPFS not available in this browser/context |
| `ERR_FILE_NOT_FOUND` | `open(mode:'read')` on a missing file |
| `ERR_QUOTA_EXCEEDED` | Storage write over quota |
| `ERR_WORKER_SPAWN` | Worker failed to start |
| `ERR_BRIDGE_TIMEOUT` | RPC timed out (default 10s) |
| `ERR_HW_DENIED` | User denied a hardware permission |
| `ERR_HW_UNSUPPORTED` | Capability absent in this environment |
| `ERR_HW_GESTURE_REQUIRED` | API needs a user gesture |
| `ERR_SYNC_NETWORK` | Transient network failure during flush |
| `ERR_SYNC_REJECTED` | Permanent HTTP 4xx / schema rejection |
| `ERR_PERMISSION_DENIED` | Daemon capability not granted |
| `ERR_UNKNOWN` | Unclassified failure |

All errors are thrown as `OxelotError` (`instanceof Error`, `code`, `message`, `cause?`).

---

## 5.7 React Hooks (`@oxelot/react`) — normative

```ts
// react/src/hooks.ts
export function useOxelot(config?: OxelotConfig): Oxelot
//   - calls Oxelot.init once (StrictMode-safe), disposes on unmount.

export function useOxelotStorage<T>(key: string): {
  data: T | null
  loading: boolean
  error: OxelotError | null
  write: (value: T) => Promise<void>   // optimistic; sets data immediately
  remove: () => Promise<void>
}
//   - subscribes to 'storage-change'; reloads on cross-tab events.

export function useOxelotDB<T>(query: (db: DatabaseFacade) => Promise<T>, deps?: unknown[]): {
  result: T | null
  loading: boolean
  error: OxelotError | null
  refresh: () => void
}
//   - runs query via pool on dep change; caches last result.

export function useOxelotSyncStatus(): {
  state: SyncState
  pending: number
  deadLetters: number
  flush: () => Promise<void>
}
```

React bindings re-export core types (`Oxelot`, `OxelotConfig`, `DatabaseFacade`, …) so consumers can `import { Oxelot } from '@oxelot/react'`. Hooks are built **on top of** core; they never modify core.

---

## 5.8 Normative references
- Threading/message protocol: [Chapter 6](06-state-management-threading.md)
- Anti-patterns & performance budget: [Chapter 7](07-boundaries-constraints.md)
- Implementation order & worker boilerplate: [Chapter 9 §9.3](09-implementation-guide.md)
- Consumer examples: [Chapter 10](10-user-guide.md)
