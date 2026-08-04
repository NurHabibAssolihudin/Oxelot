# ADR-05 — Interim WASM SQLite Persistence via serialize/deserialize

## Status
Accepted

## Context

Chapter 5 §5.1.4 specifies a full byte-level OPFS VFS for the WASM SQLite build: SQLite writes pages straight into an OPFS-backed file so only dirty pages cross the boundary. The shipped target is `wasm32-wasip1` (rustc 1.97 removed the legacy `wasm32-wasi` name), compiled with zig as the C compiler.

Implementing a real `sqlite3_vfs` for OPFS from Rust requires (a) exposing every VFS method (`xOpen`, `xRead`, `xWrite`, `xLock`, `xShmMap`, …) through the wasm↔JS boundary and (b) keeping a handle-to-file mapping alive on the JS side. That is a large surface for M1.4 and can be deferred without blocking `db.run`/`db.query`.

SQLite ships `sqlite3_serialize()` / `sqlite3_deserialize()`, which copy the **whole** main database image into one buffer (and, importantly, only capture the main database file — a WAL journal is excluded). This gives us a correct, low-risk persistence primitive in ~100 lines of Rust.

## Decision

**Ship M1.4 with image-based persistence: serialize the entire DB to bytes on mutation and deserialize them back on boot, stored as a single OPFS file.** The full VFS remains the documented end-state; this ADR records the interim strategy.

- The Rust module (`wasm/sqlite-vfs`) exposes a plain `extern "C"` ABI (no `wasm-bindgen`):
  `alloc/dealloc`, `init(image_ptr, image_len)`, `run`, `query`, `export_db`, `result_ptr`, `result_len`.
  `init` opens an in-memory connection; when `image_len > 0` it deserializes the supplied image. `export_db` serializes the current image into the result buffer.
- `init` sets `journal_mode = DELETE` and `synchronous = NORMAL`: serialize captures only the main DB file, so a write-ahead journal must never be left behind.
- The worker (worker-entry.ts) loads the persisted image file (`{dbName}.sqlite`) at first db op, seeds the instance, executes `db.run`/`db.query`, and after each mutation calls `export_db` and writes the image back to OPFS. `db.checkpoint` forces a persist without running SQL.
- **All `db.*` ops are pinned to worker 0.** SQLite is a single in-memory instance living on one worker; the pool would otherwise round-robin `db.run`/`db.query` across workers, each holding an independent database. `OxelotPool.request` gains an optional `worker` hint (`PoolRequestOptions.worker`) and routes only there.
- **Op family naming:** Chapter 5 §5.1.4/§6 specify a `db.exec` op family; the shipped worker implements it as `db.run`, `db.query`, and `db.checkpoint` (narrower than `exec`, with no `exec` alias). Public `DatabaseFacade` methods keep their documented names.
- Build: `npm run build:wasm` = `cargo build --target wasm32-wasip1 --release` + copy the `.wasm` into `packages/core/dist/wasm/`. The JS loader instantiates it with a minimal `wasi_snapshot_preview1` shim (preopen scan terminated via `EBADF`, no file access). The `.wasm` is a lazy runtime-fetched asset, excluded from the G7 bundle gate.

## Consequences

**Positive (+):**
- `db.run`/`db.query`/`db.checkpoint` work end-to-end, with persistence across page reloads (e2e: `SQLite WASM: db round-trip and persistence across reload`).
- Single contiguous image is simple to reason about and trivially movable to a real OPFS VFS later.
- Manual extern-C ABI removes the `wasm-bindgen` dependency and its glue overhead.

**Negative (−):**
- Every mutation rewrites the whole DB image to OPFS (O(db size) write amplification). Acceptable while images are small; must be revisited before real workloads.
- Pinning all db ops to worker 0 serializes database work behind one worker and halves pool parallelism for db-heavy apps.
- Image persistence is all-or-nothing: a crash mid-write risks losing the whole database (mitigated by `writeBytes` + `truncate(0)` + `sync` ordering on the file handle).

**Neutral (~):**
- `:memory:` + serialize means the database does not survive a full worker restart within a session unless persisted; that is the point of the OPFS image file.
- Loader keeps the graceful `ERR_UNKNOWN` degradation when the `.wasm` asset is absent.

## Alternatives considered
- **Full OPFS VFS (spec §5.1.4)** — deferred, not rejected: the correct end-state, but a large ABI surface for M1.4.
- **WAL-mode + serialize** — rejected: serialize only captures the main DB file; a WAL journal would be silently dropped.
- **`wasm32-wasi` target to reuse libsqlite3-sys's built-in wasi handling** — removed from rustc 1.97; `wasm32-wasip1` + rusqlite 0.40 (libsqlite3-sys 0.38 detects `wasm32-wasi*` and applies the wasm C flags itself) is the supported path.
- **Per-worker SQLite (shard by worker)** — rejected: would require distributed transaction coordination far beyond M1.4 scope.
