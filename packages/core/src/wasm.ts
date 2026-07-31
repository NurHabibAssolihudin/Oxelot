import { oxError } from './errors'

export interface SqliteWasm {
  init(dbName: string): void
  run(sql: string, paramsJson: string): void
  query(sql: string, paramsJson: string): string
}

let cached: SqliteWasm | null = null
let loadPromise: Promise<SqliteWasm> | null = null

const WASM_GLUE_URL = /* @__PURE__ */ new URL('../dist/wasm/oxelot_sqlite_vfs.js', import.meta.url)

/**
 * Lazily loads and caches the WASM SQLite module. Called on first `db`
 * request; never on the app-bootstrap path (G7). Degrades to an explicit
 * error if the .wasm asset was not built (`npm run build:wasm`).
 */
export function loadWasm(dbName: string): Promise<SqliteWasm> {
  if (cached) return Promise.resolve(cached)
  if (loadPromise) return loadPromise
  loadPromise = (async () => {
    try {
      const mod = (await import(/* @vite-ignore */ WASM_GLUE_URL.href)) as unknown as { default: SqliteWasm }
      const wasm = mod.default
      wasm.init(dbName)
      cached = wasm
      return wasm
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
