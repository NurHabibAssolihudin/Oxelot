# ADR-02 — Adopt OPFS over plain IndexedDB for High-Throughput I/O

## Status
Accepted

## Context
Requirement G2 demands GB-scale offline storage with durable semantics and G3 demands fast worker communication. The two candidate backends:

- **IndexedDB (IDB):** object-store oriented; each request is an async IDB transaction (~ms-scale round trips); no byte-range/offset access; no synchronous API; strong for structured records, weak for bulk binary I/O.
- **OPFS (Origin Private File System):** real file semantics with `createSyncAccessHandle()` (worker-only, synchronous, buffered, fast), byte-offset reads/writes, `truncate`, `getSize`, `flush`; available in Chromium and Safari 15.2+.

Additional force: WASM SQLite needs a real file image (its VFS calls `xOpen/xRead/xWrite/xSync/xTruncate/xFileSize`). IDB cannot serve as a raw file VFS without an in-memory shim that defeats durability.

## Decision
**OPFS is the primary storage backend; IndexedDB is demoted to a conformant fallback. WASM SQLite runs against the OPFS VFS.**

- `StorageProvider` interface (Chapter 5 §5.1.2) has two implementations: `OpfsStorage` (primary) and `IdbStorage` (fallback).
- Backend selection: `config.storageBackend ∈ 'opfs' | 'indexeddb' | 'auto'`; `'auto'` selects OPFS only when `navigator.storage?.getDirectory` exists **and** the code runs in a worker (sync handles are worker-only); otherwise IndexedDB.
- SQLite uses the OPFS VFS in WAL mode (`synchronous=NORMAL`, checkpoint on close).
- Raw file bytes and the DB image live in OPFS; IDB stores metadata (feature flags, sync cursor, fallback rows).
- Attempting `'opfs'` on the main thread returns a typed rejection `ERR_OPFS_MAIN_THREAD` (Chapter 7 B-5, error table in Chapter 5 §5.6).

## Consequences
**Positive (+):**
- Sustained binary throughput orders of magnitude above IDB (buffer I/O vs structured-clone transactions).
- Real `.db` file on disk: inspectable with the `sqlite3` CLI; migrations behave like native apps.
- Enables G2 (GB-scale) without quota prompts in the supported browsers.

**Negative (−):**
- Requires Secure Context; Safari < 15.2 lacks OPFS → the IndexedDB fallback is mandatory and must be kept conformant (Chapter 5 §5.1.3).
- Sync access handles are **worker-only**, which hard-couples the architecture to the worker pool (Chapter 6). This is accepted; it is also what keeps G1 true.
- OPFS semantics differ subtly across engines (e.g., `flush` visibility); the OPFS test matrix explicitly covers Chromium + Safari 15.2+.

**Neutral (~):**
- Browser storage-eviction behavior for OPFS remains vendor-defined; the journaling design in Chapter 6 §6.3.4 makes Oxelot resilient to eviction of *non-synced* data.

## Alternatives considered
- **Pure IndexedDB with an in-memory SQLite shim** — rejected: defeats durability; shim state is lost on tab close; cannot meet G2.
- **Cache Storage API as a file store** — rejected: designed for HTTP request/response caching; awkward byte-offset writes; lifecycle tied to SW events.
- **Private File System with only async handles (`createWritable`)** — rejected: async handles are slower and each write is a full stream; sync handles are the high-throughput path we need.
- **SQLean / other SQLite forks** — out of scope: SQLite vanilla via OPFS VFS satisfies all requirements.
