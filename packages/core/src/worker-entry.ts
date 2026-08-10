import { handleMessages, emitEvent } from './core/pool/worker-handler'
import { createWorkerStorage } from './core/storage'
import type { WorkerStorageFacade } from './core/storage'
import type { StorageBackend } from './core/storage'
import { createStorageGuard } from './core/storage/locks'
import { loadWasm } from './wasm'
import type { SqliteWasm } from './wasm'

let DB_NAME = 'oxelot.db'
let DB_BACKEND: StorageBackend | undefined
let SOURCE_TAB = ''
let storagePromise: Promise<WorkerStorageFacade> | null = null
let dbPromise: Promise<{ wasm: SqliteWasm; imageFile: string }> | null = null

// Cross-realm storage guard (M2.3): every file/KV write and read in the worker
// realm runs under `oxelot-storage:<name>` (Web Locks), the same lock set the
// service worker and sibling tabs use, so writes to the shared queue and the DB
// image file serialize across realms. No-op when Web Locks are unavailable.
const storageGuard = createStorageGuard(
  (globalThis as unknown as { navigator?: { locks?: LockManager } }).navigator?.locks,
)

async function guarded<T>(name: string, fn: () => Promise<T>): Promise<T> {
  return storageGuard.withLock(name, fn)
}

function notify(key: string): void {
  const message = { key, sourceTab: SOURCE_TAB }
  emitEvent('storage-change', message)
}

function storage(): Promise<WorkerStorageFacade> {
  if (!storagePromise) {
    storagePromise = createWorkerStorage(DB_BACKEND)
  }
  return storagePromise
}

async function withFile(
  name: string,
  mode: 'read' | 'readwrite',
  fn: (f: Awaited<ReturnType<WorkerStorageFacade['open']>>) => Promise<unknown>,
): Promise<unknown> {
  const f = await (await storage()).open(name, mode)
  try {
    return await fn(f)
  } finally {
    await f.close()
  }
}

/** File that stores the serialized DB image (interim ADR-05 persistence). */
function dbImageFile(): string {
  return `${DB_NAME}.sqlite`
}

/**
 * Lazily boots the SQLite wasm instance, seeding it from the persisted DB
 * image if one exists. The worker owns a single instance shared by all db ops.
 */
function db(): Promise<{ wasm: SqliteWasm; imageFile: string }> {
  if (!dbPromise) {
    dbPromise = (async () => {
      const wasm = await loadWasm(DB_NAME)
      const imageFile = dbImageFile()
      let image: Uint8Array = new Uint8Array(0)
      try {
        image = (await guarded(imageFile, () =>
          withFile(imageFile, 'read', async (f) => f.readBytes(0, await f.size())),
        )) as Uint8Array
      } catch {
        // No persisted image yet; start with an empty database.
      }
      wasm.init(DB_NAME, image)
      return { wasm, imageFile }
    })()
  }
  return dbPromise
}

/** Serialize the in-memory DB and write the image to storage. */
async function persistDb(wasm: SqliteWasm, imageFile: string): Promise<void> {
  const image = wasm.persist()
  await withFile(imageFile, 'readwrite', async (f) => {
    await f.truncate(0)
    await f.writeBytes(0, image)
    await f.sync()
  })
}

const typed =
  <T>(fn: (payload: T, transfer?: ArrayBuffer[]) => unknown | Promise<unknown>) =>
  (payload: unknown, transfer?: ArrayBuffer[]) =>
    fn(payload as T, transfer)

handleMessages({
  'config': typed(async ({ dbName, storageBackend, dbEnabled, sourceTab }: { dbName?: string; storageBackend?: StorageBackend; dbEnabled?: boolean; sourceTab?: string }) => {
    if (typeof dbName === 'string' && dbName.length > 0) DB_NAME = dbName
    if (storageBackend === 'opfs' || storageBackend === 'indexeddb' || storageBackend === 'auto') {
      DB_BACKEND = storageBackend
    }
    if (typeof sourceTab === 'string' && sourceTab.length > 0) SOURCE_TAB = sourceTab
    void dbEnabled
    return null
  }),
  'ping': async () => {
    return null
  },
  'storage.readBytes': typed(async ({ name, offset, length }: { name: string; offset: number; length: number }) => {
    return guarded(name, () =>
      withFile(name, 'read', async (f) => {
        const data = await f.readBytes(offset, length)
        return data.buffer
      }),
    )
  }),
  'storage.writeBytes': typed(
    async ({ name, offset, data }: { name: string; offset: number; data: Uint8Array }) => {
      await guarded(name, () =>
        withFile(name, 'readwrite', async (f) => {
          await f.writeBytes(offset, data)
          await f.sync()
        }),
      )
      notify(name)
    },
  ),
  'storage.truncate': typed(async ({ name, size }: { name: string; size: number }) => {
    await guarded(name, () =>
      withFile(name, 'readwrite', async (f) => {
        await f.truncate(size)
        await f.sync()
      }),
    )
    notify(name)
  }),
  'storage.getSize': typed(async ({ name }: { name: string }) => {
    return guarded(name, () => withFile(name, 'read', async (f) => f.size()))
  }),
  'storage.remove': typed(async ({ name }: { name: string }) => {
    const s = await storage()
    await guarded(name, () => s.remove(name))
    notify(name)
  }),
  'storage.entries': async () => {
    const s = await storage()
    return s.entries()
  },
  'kv.set': typed(async ({ key, value }: { key: string; value: unknown }) => {
    const s = await storage()
    await guarded(key, () => s.set(key, value))
    notify(key)
  }),
  'kv.get': typed(async ({ key }: { key: string }) => {
    const s = await storage()
    return guarded(key, () => s.get(key))
  }),
  'db.run': typed(async ({ sql, paramsJson }: { sql: string; paramsJson: string }) => {
    const { wasm, imageFile } = await db()
    wasm.run(sql, paramsJson)
    await guarded(imageFile, () => persistDb(wasm, imageFile))
    notify(imageFile)
  }),
  'db.query': typed(async ({ sql, paramsJson }: { sql: string; paramsJson: string }) => {
    const { wasm } = await db()
    return JSON.parse(wasm.query(sql, paramsJson)) as unknown
  }),
  'db.checkpoint': async () => {
    const { wasm, imageFile } = await db()
    await guarded(imageFile, () => persistDb(wasm, imageFile))
    return null
  },
})
