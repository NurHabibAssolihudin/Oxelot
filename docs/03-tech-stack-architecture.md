# 3. Tech Stack & Architecture

**Chapter status:** Final (v0.1.0) · **File:** `docs/03-tech-stack-architecture.md`

---

## 3.1 Core Languages

| Layer | Language | Rationale | Enforcement |
|-------|----------|-----------|-------------|
| Library core (all runtime logic, bridges, hooks-adjacent primitives) | **TypeScript (strict)** | Static typing across the `postMessage` boundary prevents protocol drift; editor-grade autocompletion for consumers | `tsconfig` with `strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`, `noImplicitOverride: true`, `verbatimModuleSyntax: true` |
| WASM modules | **Rust** (primary), C++ (allowed) | Rust gives memory safety + `wasm-bindgen` ergonomics for the SQLite OPFS VFS; C++ only for hand-tuned VFS shims where bindings are impractical | `cargo clippy -- -D warnings`; `#![deny(unsafe_code)]` except in the thin FFI boundary module |
| Config/build tooling | TypeScript + JSON + shell | Uniform with the runtime | ESLint/prettier on `.ts` |

**Version pins (minimums, per README §8.1):**
- Node.js ≥ 22 LTS (CI runs on 22).
- TypeScript ≥ 5.4.
- Rust ≥ 1.75, target `wasm32-unknown-unknown`; wasm-pack ≥ 0.12.

> Actual as of v0.1.0 (deviation → ADR-05): the WASM crate builds to `wasm32-wasip1` with **zig 0.16** as the C compiler (no wasm-pack / wasm-bindgen); `wasm32-wasi` was removed in rustc 1.97. See docs/08 §8.1 for the working toolchain.

---

## 3.2 Architectural Patterns

### 3.2.1 Facade pattern — public surface
`Oxelot` (in `packages/core/src/core/index.ts`) is the **only** public entry. It aggregates five sub-facades:

```
Oxelot (facade)
├── storage  : StorageFacade
├── db       : DatabaseFacade
├── sync     : SyncFacade
├── hardware : HardwareBridge
└── pool     : OxelotPool
```
- Internals are **not** exported from the package entry (`index.ts` re-exports only the facade + top-level types).
- All sub-facades implement interfaces (`StorageFacade`, etc.) so consumers can substitute implementations for testing.

### 3.2.2 Worker-pool pattern — concurrency
`OxelotPool` owns N dedicated `Worker` instances. Main thread never blocks; work is dispatched as `{op, payload}` messages. Properties:
- **FIFO queue per pool**; no starvation (round-robin assignment).
- **Load tracking** via `pool.load() ∈ [0,1]` (in-flight ÷ concurrency) for backpressure (§6.3.3).
- **Crash respawn:** on worker `error`/termination, in-flight requests are re-dispatched once, then failed to the caller.

### 3.2.3 Proxy/promise bridge — RPC
`OxelotBridge` wraps `postMessage` in typed promises with correlation IDs; zero-copy via `Transferable` (`ArrayBuffer`, `MessagePort`, `ImageBitmap`). Fully specified in Chapter 6 §6.2.

### 3.2.4 Repository pattern — storage abstraction
`StorageProvider` interface abstracts the backend. Two implementations:
- `OpfsStorage` (primary, worker-only, sync handles).
- `IdbStorage` (fallback, async, IndexedDB).

Selection logic in `StorageFacade.create()`: `config.storageBackend` ∈ `'opfs' | 'indexeddb' | 'auto'`; `'auto'` resolves to OPFS when `navigator.storage?.getDirectory` exists AND running inside a worker context (sync handles are worker-only), else IndexedDB.

---

## 3.3 Data & Storage Layer

### 3.3.1 System diagram (canonical)

```
                 ┌─────────────────────────────────────────────┐
                 │              Main Thread (UI)                │
                 │   @oxelot/react Hooks → Oxelot facade        │
                 │   (React/consumer framework lives HERE only) │
                 └────────────────────┬────────────────────────┘
                                      │ postMessage (Transferables)
                                      │ structured clone for non-binary
                 ┌────────────────────▼────────────────────────┐
                 │              Worker Pool (2..N)              │
                 │   Worker[0]   Worker[1]   ...  Worker[N-1]   │
                 │   each: sync-handle OPFS + WASM SQLite       │
                 └──────────────┬──────────┬────────────────────┘
                                │          │
              ┌─────────────────▼───┐  ┌───▼──────────────────────┐
              │ OPFS (FileSystem    │  │ IndexedDB (fallback only)│
              │ Access Handle,      │  │ implements StorageProvider│
              │ worker-only sync    │  └──────────────────────────┘
              │ access handles)     │
              └─────────┬───────────┘
                        │ raw byte I/O (xRead/xWrite/xOpen)
              ┌─────────▼────────────────────────────────────────┐
              │ WASM SQLite (compiled Rust, OPFS VFS backend)    │
              │ WAL mode · checkpoint on close · crash-safe      │
              └──────────────────────────────────────────────────┘

              (optional, Phase 3, out-of-process)
              ┌──────────────────────────────────────────────────┐
              │ Local Daemon  ws://127.0.0.1:PORT (WebSocket)    │
              │   or WebRTC DataChannel fallback                 │
              │   → USB serial, raw sockets, file watchers       │
              └──────────────────────────────────────────────────┘
```

### 3.3.2 Storage backends and their roles

| Backend | Role | Key property |
|---------|------|--------------|
| **OPFS** | Primary storage (files, DB files, sync queue journal) | Durable, fast, real file semantics, worker-usable sync handles |
| **IndexedDB** | Fallback + small metadata (feature flags, sync cursor) | Always available, structured-clone-friendly, no sync handles |
| **WASM SQLite (OPFS VFS)** | Structured query layer on top of OPFS | Real SQLite database file; inspectable with `sqlite3` CLI |
| **Local daemon (Phase 3)** | Out-of-browser hardware bridge | Owns hardware OPFS cannot reach |

**Data-flow rule:** raw file bytes live in OPFS; metadata/queues may also use IndexedDB; **nothing** heavy crosses to the main thread. All three storage-related writes happen inside workers.

### 3.3.3 OPFS specifics
- File opened via `navigator.storage.getDirectory()` → `getFileHandle(name, { create: true })` → `createSyncAccessHandle()`.
- Sync handle methods used: `read(buffer, {at})`, `write(buffer, {at})`, `truncate(size)`, `getSize()`, `flush()`.
- Sync handles are **worker-only**; the facade refuses `'opfs'` on the main thread with `ERR_OPFS_MAIN_THREAD`.
- Writes are `flush()`-ed before `close()`; `flush` cost is accounted in the G3 budget.

### 3.3.4 WASM SQLite specifics
- Rust crate `wasm/sqlite-vfs` links SQLite compiled for `wasm32-unknown-unknown` against the OPFS VFS.
- Modes: `WAL`; `synchronous=NORMAL` for durability/throughput balance; auto-checkpoint on `close()`.
- Instantiation is **lazy**: `db` sub-facade loads the `.wasm` on first use, caches the instance, and never runs on the app-bootstrap path (G7).

---

## 3.4 Ecosystem & Bundling

| Concern | Tool | Version pin | Why |
|---------|------|-------------|-----|
| Monorepo | **npm** workspaces | ≥ 22 LTS | npm workspaces (chosen over pnpm for environment availability; `pnpm` is a drop-in alternative) |
| Build (lib) | **tsup** | ≥ 8 | ESM + CJS + `.d.ts` in one pass; tree-shakable, `sideEffects: false` |
| Dev/example | **Vite** | ≥ 5 | Playground + e2e `webServer` |
| Unit tests | **Vitest** | ≥ 1 | Vite-native, worker-compatible test runner |
| E2E | **Playwright** | ≥ 1.44 | Chromium/Firefox/WebKit; SW + OPFS support |
| Lint | **ESLint** 9 flat config + `typescript-eslint` (strict) | ≥ 9 / ≥ 8.3 | Enforces Chapter 7 rules |
| Format | **Prettier** | ≥ 3 | Consistency |
| Dependency graph | **dependency-cruiser** | latest | G6: core imports no framework |
| WASM | **wasm-pack** + `wasm-bindgen` | ≥ 0.12 / ≥ 0.2 | Rust → wasm + JS glue |
| Type checks | **tsc --noEmit** | TS ≥ 5.4 | Strict CI gate |

### 3.4.1 Output matrix for `@oxelot/core`
| Format | File | Consumed by |
|--------|------|-------------|
| ESM | `dist/index.js` (package `"type": "module"`) | Modern bundlers, browser `<script type=module>` |
| CJS | `dist/index.cjs` | Node, legacy toolchains |
| Types | `dist/index.d.ts` | TS consumers |
| WASM | `dist/wasm/sqlite_vfs_bg.wasm` + glue | Loaded lazily by `db` sub-facade |

- `package.json` → `"type": "module"`, `"sideEffects": false`, `"exports"` map with `types` condition first.
- React bindings in `packages/react` re-export core; consumers may import `@oxelot/react` alone.

### 3.4.2 Strict-mode TS baseline (`packages/core/tsconfig.json`)
```jsonc
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "verbatimModuleSyntax": true,
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "WebWorker"],
    "skipLibCheck": true,
    "noEmit": true
  }
}
```

---

## 3.5 Chapter cross-references

- Message protocol details → [Chapter 6 §6.2](06-state-management-threading.md)
- Worker bridge boilerplate → [Chapter 9 §9.3](09-implementation-guide.md)
- Storage contracts → [Chapter 5 §5.1](05-core-modules-and-specs.md)
- Tooling setup commands → [Chapter 8 §8.3](08-developer-guide.md)
