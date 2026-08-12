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
  /** Peek the front of the queue without removing it (inspection). */
  peek(): Promise<OxelotMutation | undefined>
  /** Drain the queue: deliverable attempts, backoff for transient failures. */
  flush(): Promise<{ delivered: number; deadLetters: number }>
  /** Count pending + dead-letter. */
  status(): Promise<{ pending: number; deadLetters: number }>
  onStateChange(cb: (s: SyncState) => void): () => void
}
```

**Delivery semantics (normative):**
- **Exactly-once by stable `id`:** `enqueue` drops an envelope whose `id` is already pending. Re-enqueueing the same `id` after success reappends it (a re-created mutation is a new contract).
- **Atomic pop-on-success:** an envelope is removed from the queue only *after* the server acknowledges delivery (`2xx`). It is never removed before a successful delivery attempt.
- **Checkpointed drains:** long flushes persist the kept prefix + not-yet-attempted tail every `checkpoint` successes, so a crash loses at most `checkpoint` already-delivered envelopes.
- **Persistence:** the queue is stored in the shared IndexedDB `oxelot`/`kv` store (page via the worker pool and service worker read the same object store), not in memory.

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

- Delivery: `POST ${sync.serverUrl}` with JSON `{ schemaVersion, id, collection, op, payload }`; consumer acknowledges with HTTP `2xx`. Deliveries are idempotent by `id` on the consumer side; the client enqueue dedupes by `id` (§5.2.3).
- Transient = network error or HTTP `5xx`/`429` (with `Retry-After` respected when present).
- Permanent = HTTP `4xx` (except `408`/`429`) or schema error → dead letter.
- Backoff schedule: attempt `1→30s`, `2→1m`, `3→5m`, `4→30m`, `5+→1h` (cap). `attempts` persists across page loads (stored with the envelope).
- Pop-on-success: an envelope is deleted from the queue only after a `2xx`; a crash mid-drain replays at most the already-delivered tail since the last checkpoint (see §5.2.3).

### 5.2.5 Web Locks integration (normative)

- All flush work acquires the exclusive `oxelot-sync` lock **with blocking acquisition** so that exactly one flusher (page, sibling tab, or service worker — same origin, shared lock set) is active at a time. A concurrent flusher queues behind the active drain and then no-ops on the empty queue; no envelope is delivered twice. (`ifAvailable`/skip-based arbitration is not used: some Chromium builds grant `ifAvailable` requests even under cross-realm contention.)
- Storage writes AND reads run under the exclusive `oxelot-storage:<name>` lock (same origin, all realms — worker file/KV ops, service-worker KV ops), so writes to the shared queue/DB image and multi-step file writes serialize, and readers never observe a partially-written value. Lock namespaced per file/KV key; no-op (degraded) where Web Locks are unavailable.
- After a locked write releases, a `storage-change` fires and propagates to sibling tabs (Chapter 6 §6.2.1) in time for cache invalidation — measured ≤100 ms (M1.5/M2.3 e2e).
- Lock timeouts: 30s max; release via `finally`.

### 5.2.6 Service worker contract

`sw.ts` (consumer-registered, or registered by `Oxelot.init` when `registerSW: true`):
- Listens for `sync` events; calls `sync.flush()`.
- Listens for `periodicsync` events (M2.4); only the `oxelot-sync` tag is honored — also calls `sync.flush()`.
- Listens for `message` (`type: 'oxelot-sync'`) to trigger an explicit flush from a tab.
- Never touches DOM (SW has none). Uses the same `SyncService` module (bundled into the SW build via the pool's SW variant).
- Reads and writes the **same queue** as pages: the shared IndexedDB `oxelot`/`kv` store. The page-side queue (proxied through the worker pool) and the SW-side queue (`WorkerKv`) resolve to the same `IdbStorage` object store, so one flush from either context drains the same origin-wide queue (consumer idempotency by `id` guards concurrent drains). KV ops in both paths run under the `oxelot-storage:<key>` Web Lock (§5.2.5).
- The SW's sync queue is constructed with the same `oxelot-sync` Web Lock the page-side queue uses, so a SW drain and a tab drain cannot run concurrently (single active flusher, §5.2.5).

### 5.2.7 Periodic background sync (normative, M2.4)

- **Opt-in.** `OxelotConfig.features.periodicSync` (default absent): `true` registers the `oxelot-sync` periodic tag at a default 12 h minimum interval; a number sets the minimum interval in ms. Browsers may clamp to their own larger minimum.
- **Registration.** Page-side (`registerServiceWorker`): for the active registration, `registration.periodicSync.register(SYNC_TAG, { minInterval })`. Only attempted when the flag is on and `registration.periodicSync` exists; both conditions failing is a **graceful no-op** — the app, SW, and one-shot sync are unaffected. All registration rejections are swallowed and reported via `console.info`, never thrown.
- **Fire path.** The SW's `periodicsync` handler flushes the shared queue for the matching tag under the `oxelot-sync` Web Lock (§5.2.5), exactly like a `sync` or relay flush.
- **Surfacing.** `Oxelot.syncCapabilities(): Promise<{ backgroundSync, periodicSync }>` (M2.4 slice 4.2) reports which mechanisms the environment exposes on the registration: `sync` ⇔ one-shot (connectivity restore), `periodicSync` ⇔ periodic cadence. Never throws; returns `false` where no usable registration exists. Independent of the feature flag (it describes the environment, not whether the app registered).

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

**Spec status:** v1 (M3.1 kickoff, ADR-07). Additive — core works identically without the daemon.

### 5.4.1 Purpose
Out-of-browser hardware access (raw serial, sockets, file watchers, system stats, NFC polling without a gesture) that Fugu cannot provide. The daemon binary is **distributed separately** (installer, out of core scope, Chapter 2 §2.6); core only implements the client side of this contract.

### 5.4.2 Transport
- **Primary:** `ws://127.0.0.1:<port>` (default **47500**; overridable via `OxelotConfig.daemon.port`). Only `127.0.0.1` / `[::1]` / `localhost` host allowed.
- **Fallback:** WebRTC DataChannel (negotiated manually) when the WebSocket handshake times out (> `connectTimeoutMs`, default 2000 ms).
- **Heartbeat:** `{type:'ping'}` from the client every 15 s; `{type:'pong'}` expected from the daemon within 5 s; **2 missed beats ⇒ connection reset** with exponential backoff (500 ms → 1 s → 2 s … capped at 30 s, reset on `ready`, §5.4.5).

### 5.4.3 Frame layout (normative, v1)

One JSON object per WebSocket message. Every message carries `type`; `hello`, `request`, `response`, `event`, `ping`, `pong` further carry `protocolVersion` (currently `1`). Unknown `type` or unsupported `protocolVersion` ⇒ the receiving end treats the frame as **malformed** (`ERR_DAEMON_SCHEMA` / `ERR_DAEMON_VERSION`).

```ts
type DaemonMessage =
  // Connection lifecycle (client → daemon)
  | { type: 'hello'; app: 'oxelot'; protocolVersion: 1; clientId: string }
  // Capability advertisement (daemon → client, sent once after 'hello')
  | { type: 'advertise'; protocolVersion: 1; caps: CapabilityAdvertisement[] }
  // Capability RPC
  | { type: 'request'; protocolVersion: 1; id: string; cap: string; data?: unknown }   // client → daemon
  | { type: 'response'; protocolVersion: 1; id: string; cap: string; ok: true; data?: unknown }
  | { type: 'response'; protocolVersion: 1; id: string; cap: string; ok: false; error: { code: string; message: string } }
  | { type: 'event'; protocolVersion: 1; cap: string; data?: unknown }                 // daemon → client push (watch/stats)
  // Keepalive
  | { type: 'ping' } | { type: 'pong' }

interface CapabilityAdvertisement {
  cap: string                       // namespaced 'domain:action', e.g. 'serial:read'
  permission: boolean               // true → daemon.grant(cap) required before any request
  schema?: Record<string, unknown>  // informational request/response shape hint
}
```

Rules:
- `id` is a client-generated correlation id; responses echo it. An unknown `id` on a response ⇒ schema violation (resets the connection).
- A client may pipeline independent `request`s; receive order of responses is not guaranteed.
- `event` frames are fire-and-forget pushes tied to a granted capability (e.g., `file:watch` mutations).
- `data` is capability-defined (see §5.4.6); the core bridge passes it through after schema validation of the *envelope*.

### 5.4.4 Connection state machine (normative)

```
disconnected ──connect()──► connecting ──advertise received──► ready
      ▲                          │   │
      │  2 missed beats /        │   └─ hello not answered within connectTimeoutMs ─┐
      │  schema/version error    │   └─ (optionally) WebRTC DataChannel fallback ───┤
      └──backoff(500ms→30s cap)──┴── reset ─────────────────────────────────────────┘
```

- `disconnected → connecting` on `daemon.connect()` (or implicitly on first capability use).
- `connecting → ready` only after a valid `advertise` (`protocolVersion:1`); the advertised `caps` populate the capability registry (§5.4.6).
- `ready → disconnected` on: socket close, 2 missed heartbeats, `ERR_DAEMON_SCHEMA`/`ERR_DAEMON_VERSION` on a connection frame, or explicit `daemon.dispose()`.
- On `ready → disconnected`, retry with exponential backoff (500 ms ×2, cap 30 s) while `features.daemon` is on and a consumer holds a `daemon` handle. Backoff resets on `ready`.
- While `disconnected`, every capability call rejects with `ERR_DAEMON_CONNECT` (never queues).

### 5.4.5 Security boundary (normative)

1. Connect **only** to `127.0.0.1` / `[::1]` / `localhost`; reject any other host.
2. **Origin gate:** the daemon accepts only connections whose `Origin` header is a local http(s) origin (host `localhost`, `127.0.0.1`, `[::1]`) or absent; pages on remote origins are rejected at the WebSocket handshake. The core client additionally refuses non-localhost URLs even if misconfigured.
3. **Handshake:** client sends `{type:'hello', app:'oxelot', protocolVersion:1, clientId}`; daemon replies with the capability list (`advertise`); both ends validate the schema and version (v1 only, `ERR_DAEMON_VERSION` otherwise).
4. **Per-capability permission:** a capability with `permission:true` is honoured only after the consumer calls `daemon.grant(cap)` (requires a **user gesture**, re-prompted per session); otherwise `ERR_PERMISSION_DENIED`.
5. **No secrets on the wire:** no credentials/tokens travel over WebSocket; the daemon stores its own state. Advertised `schema` hints are informational, not normative.
6. **Fuzz target:** ≥ 1 M malformed frames must not crash the daemon nor bypass permissions (Phase 3 exit criteria, Chapter 2 §2.3).

### 5.4.6 Capability registry (normative home; implementations M3.3)

Each capability is `domain:action` with a declared request/response shape in the registry (referenced from `advertise.caps[].schema`). v1 registry:

| cap | permission | Request (`data`) | Response (`data`) | Errors |
|-----|-----------|------------------|--------------------|--------|
| `serial:list` | false | — | `[{ path, vendorId, productId }]` | `ERR_DAEMON_UNSUPPORTED` |
| `serial:open` | true | `{ path, baudRate }` | `{ handle }` | `ERR_PERMISSION_DENIED`, `ERR_DAEMON_NOT_FOUND` |
| `serial:read` | true | `{ handle, size }` | `{ bytes }` (base64) | `ERR_PERMISSION_DENIED` |
| `serial:write` | true | `{ handle, bytes }` (base64) | `{}` | `ERR_PERMISSION_DENIED` |
| `socket:connect` | true | `{ host, port }` | `{ handle }` | `ERR_PERMISSION_DENIED`, `ERR_SYNC_NETWORK` |
| `socket:relay` | true | `{ handle, bytes }` (base64) | — (use `event` push) | `ERR_PERMISSION_DENIED` |
| `file:watch` | true | `{ path }` | — (use `event` push) | `ERR_PERMISSION_DENIED`, `ERR_FILE_NOT_FOUND` |
| `sys:stats` | false | — | `{ cpu, mem, uptimeMs }` | `ERR_DAEMON_UNSUPPORTED` |

- Errors are the §5.6 codes (see below); capability-specific variants reuse core codes (`ERR_FILE_NOT_FOUND`, `ERR_SYNC_NETWORK`) or add no new ones.
- Unknown capability in a `request` ⇒ `ERR_DAEMON_UNSUPPORTED` in the `response`.
- This table is normative **for shape only**; actual OS backends land in M3.3 (the daemon and the client bridge both implement against this table).

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
  /** Daemon bridge settings (Phase 3, additive — see §5.4). */
  daemon?: {
    /** Daemon port on 127.0.0.1 (default 47500). */
    port?: number
    /** WebSocket handshake timeout in ms (default 2000). */
    connectTimeoutMs?: number
  }
  features?: {
    daemon?: boolean          // Phase 3: enable the daemon bridge (default false)
    /** `true` → `oxelot-sync` periodic tag at default 12 h min interval; `number` → min interval ms (engine may clamp). Unsupported = no-op (§5.2.7). */
    periodicSync?: boolean | number
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
  /** Report background-sync mechanisms the environment exposes (§5.2.7). Never throws. */
  syncCapabilities(): Promise<SyncCapabilities>
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
| `ERR_DB_DISABLED` | SQLite sub-facade disabled (`dbEnabled: false`) |
| `ERR_DB_SQL` | SQLite statement failed (WASM layer) |
| `ERR_PERMISSION_DENIED` | Daemon capability not granted |
| `ERR_DAEMON_CONNECT` | Daemon unreachable / connection failed (§5.4.4) |
| `ERR_DAEMON_TIMEOUT` | Daemon handshake or request timed out |
| `ERR_DAEMON_SCHEMA` | Daemon frame failed schema validation |
| `ERR_DAEMON_VERSION` | Daemon protocol version mismatch |
| `ERR_DAEMON_UNSUPPORTED` | Daemon capability not advertised / not implemented |
| `ERR_DAEMON_NOT_FOUND` | Daemon resource not found (e.g., serial device absent) |
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
  write: (value: T) => Promise<void>   // optimistic; sets data immediately (§6.3.2)
  remove: () => Promise<void>
}
//   - subscribes to 'storage-change'; reloads on cross-tab events.
//   - `write` persists the value (§6.3.1) AND enqueues a `storage:${key}` upsert
//     envelope (`makeStorageMutation`) for background sync; on any failure it
//     emits `error`, persists the previous value (second `storage-change`), and
//     rolls the optimistic state back.

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
