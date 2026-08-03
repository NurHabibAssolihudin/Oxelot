import { oxError } from './errors'

/**
 * Minimal interface to the Rust-compiled SQLite module
 * (`wasm/sqlite-vfs`, target `wasm32-wasip1`, plain extern-C ABI).
 *
 * The instance is backed by an in-memory database. Persistence is delivered
 * by the JS side: `load(bytes)` deserializes a previously exported image and
 * `persist()` serializes the current image out again (see ADR-05).
 */
export interface SqliteWasm {
  /** Open a fresh in-memory DB and, if `image` is non-empty, deserialize it. */
  init(dbName: string, image: Uint8Array): void
  /** Execute a statement without a result set (INSERT/UPDATE/DDL). */
  run(sql: string, paramsJson: string): void
  /** Run a query and return the JSON row array as a string. */
  query(sql: string, paramsJson: string): string
  /** Serialize the whole main DB image. */
  persist(): Uint8Array
}

let cached: SqliteWasm | null = null
let loadPromise: Promise<SqliteWasm> | null = null

const WASM_URL = /* @__PURE__ */ new URL('../dist/wasm/oxelot_sqlite_vfs.wasm', import.meta.url)

/**
 * Lazily loads, instantiates and caches the WASM SQLite module. Called on
 * first `db` request; never on the app-bootstrap path (G7). Degrades to an
 * explicit error if the .wasm asset was not built (`npm run build:wasm`).
 */
export function loadWasm(dbName: string): Promise<SqliteWasm> {
  void dbName // name is descriptive only; the DB itself is always in-memory
  if (cached) return Promise.resolve(cached)
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const bytes = await (await fetch(WASM_URL.href)).arrayBuffer()
      const module = await WebAssembly.compile(bytes)
      const instance = await instantiate(module)
      cached = wrap(instance.exports as unknown as WasmExports)
      return cached
    } catch (err) {
      loadPromise = null
      throw oxError(
        'ERR_UNKNOWN',
        'WASM SQLite not available: run `npm run build:wasm` (requires Rust toolchain, Chapter 9 Step 9)',
        err,
      )
    }
  })()
  return loadPromise
}

interface WasmExports {
  memory: WebAssembly.Memory
  alloc(len: number): number
  dealloc(ptr: number, len: number): void
  init(ptr: number, len: number): number
  run(sqlPtr: number, sqlLen: number, paramsPtr: number, paramsLen: number): number
  query(sqlPtr: number, sqlLen: number, paramsPtr: number, paramsLen: number): number
  export_db(): number
  result_ptr(): number
  result_len(): number
}

/** Instantiate the wasm module with a minimal WASI shim (wasi_snapshot_preview1). */
async function instantiate(module: WebAssembly.Module): Promise<WebAssembly.Instance> {
  const holder: { instance?: WebAssembly.Instance } = {}
  const memory = () => holder.instance!.exports.memory as WebAssembly.Memory
  const errno = (n: number) => () => n
  const imports = {
    wasi_snapshot_preview1: {
      fd_write: (fd: number, iovs: number, iovsLen: number, nwritten: number): number => {
        const view = new DataView(memory().buffer)
        for (let i = 0; i < iovsLen; i++) {
          const base = iovs + i * 8
          const len = view.getUint32(base + 4, true)
          // Ignore writes to stdout/stderr (no console in the worker is wired).
          view.setUint32(nwritten, (view.getUint32(nwritten, true) || 0) + len, true)
        }
        return 0
      },
      fd_close: errno(0),
      fd_read: errno(0),
      fd_seek: errno(0),
      fd_sync: errno(0),
      fd_fdstat_get: errno(0),
      fd_fdstat_set_flags: errno(0),
      fd_filestat_get: errno(0),
      fd_filestat_set_size: errno(0),
      fd_prestat_get: errno(8), // EBADF: no preopened dirs -> stops the preopen scan
      fd_prestat_dir_name: errno(8),
      path_create_directory: errno(0),
      path_filestat_get: errno(0),
      path_filestat_set_times: errno(0),
      path_open: errno(52), // ENOSYS: no file access; DB is in-memory
      path_readlink: errno(0),
      path_remove_directory: errno(0),
      path_unlink_file: errno(0),
      poll_oneoff: errno(0),
      proc_exit: (code: number): never => {
        throw new Error(`WASM SQLite exited with code ${code}`)
      },
      clock_time_get: (clockId: number, precision: number, out: number): number => {
        new DataView(memory().buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true)
        return 0
      },
      environ_sizes_get: (count: number, bufSize: number): number => {
        const view = new DataView(memory().buffer)
        view.setUint32(count, 0, true)
        view.setUint32(bufSize, 0, true)
        return 0
      },
      environ_get: (): number => 0,
    },
  }
  const instance = await WebAssembly.instantiate(module, imports)
  holder.instance = instance
  return instance
}

function wrap(exports: WasmExports): SqliteWasm {
  const { memory } = exports

  function writeBytes(bytes: Uint8Array): { ptr: number; len: number } {
    const ptr = exports.alloc(bytes.length)
    new Uint8Array(memory.buffer, ptr, bytes.length).set(bytes)
    return { ptr, len: bytes.length }
  }

  function readResult(): string {
    const ptr = exports.result_ptr()
    const len = exports.result_len()
    if (len === 0) return ''
    return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len))
  }

  function readResultBytes(): Uint8Array {
    const ptr = exports.result_ptr()
    const len = exports.result_len()
    return new Uint8Array(memory.buffer, ptr, len).slice()
  }

  function check(rc: number): void {
    if (rc !== 0) throw oxError('ERR_DB_SQL', readResult() || 'SQLite error')
  }

  const api: SqliteWasm = {
    init(dbName: string, image: Uint8Array): void {
      const inBuf = writeBytes(image)
      check(exports.init(inBuf.ptr, inBuf.len))
      exports.dealloc(inBuf.ptr, inBuf.len)
      void dbName // name is descriptive only; the DB is always in-memory
    },
    run(sql: string, paramsJson: string): void {
      const sqlBuf = writeBytes(new TextEncoder().encode(sql))
      const paramsBuf = writeBytes(new TextEncoder().encode(paramsJson))
      check(
        exports.run(sqlBuf.ptr, sqlBuf.len, paramsBuf.ptr, paramsBuf.len),
      )
      exports.dealloc(sqlBuf.ptr, sqlBuf.len)
      exports.dealloc(paramsBuf.ptr, paramsBuf.len)
    },
    query(sql: string, paramsJson: string): string {
      const sqlBuf = writeBytes(new TextEncoder().encode(sql))
      const paramsBuf = writeBytes(new TextEncoder().encode(paramsJson))
      const rc = exports.query(sqlBuf.ptr, sqlBuf.len, paramsBuf.ptr, paramsBuf.len)
      exports.dealloc(sqlBuf.ptr, sqlBuf.len)
      exports.dealloc(paramsBuf.ptr, paramsBuf.len)
      check(rc)
      return readResult()
    },
    persist(): Uint8Array {
      check(exports.export_db())
      return readResultBytes()
    },
  }
  return api
}
