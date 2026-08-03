import { handleMessages } from './core/pool/worker-handler'
import { createWorkerStorage } from './core/storage'
import type { WorkerStorageFacade } from './core/storage'
import type { StorageBackend } from './core/storage'
import { loadWasm } from './wasm'

let DB_NAME = 'oxelot.db'
let DB_BACKEND: StorageBackend | undefined
let storagePromise: Promise<WorkerStorageFacade> | null = null

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

const typed =
  <T>(fn: (payload: T, transfer?: ArrayBuffer[]) => unknown | Promise<unknown>) =>
  (payload: unknown, transfer?: ArrayBuffer[]) =>
    fn(payload as T, transfer)

handleMessages({
  'config': typed(async ({ dbName, storageBackend, dbEnabled }: { dbName?: string; storageBackend?: StorageBackend; dbEnabled?: boolean }) => {
    if (typeof dbName === 'string' && dbName.length > 0) DB_NAME = dbName
    if (storageBackend === 'opfs' || storageBackend === 'indexeddb' || storageBackend === 'auto') {
      DB_BACKEND = storageBackend
    }
    void dbEnabled
    return null
  }),
  'ping': async () => {
    return null
  },
  'storage.readBytes': typed(async ({ name, offset, length }: { name: string; offset: number; length: number }) => {
    return withFile(name, 'read', async (f) => {
      const data = await f.readBytes(offset, length)
      return data.buffer
    })
  }),
  'storage.writeBytes': typed(
    async ({ name, offset, data }: { name: string; offset: number; data: Uint8Array }) => {
      await withFile(name, 'readwrite', async (f) => {
        await f.writeBytes(offset, data)
        await f.sync()
      })
    },
  ),
  'storage.truncate': typed(async ({ name, size }: { name: string; size: number }) => {
    await withFile(name, 'readwrite', async (f) => {
      await f.truncate(size)
      await f.sync()
    })
  }),
  'storage.getSize': typed(async ({ name }: { name: string }) => {
    return withFile(name, 'read', async (f) => f.size())
  }),
  'storage.remove': typed(async ({ name }: { name: string }) => {
    const s = await storage()
    await s.remove(name)
  }),
  'storage.entries': async () => {
    const s = await storage()
    return s.entries()
  },
  'kv.set': typed(async ({ key, value }: { key: string; value: unknown }) => {
    const s = await storage()
    await s.set(key, value)
  }),
  'kv.get': typed(async ({ key }: { key: string }) => {
    const s = await storage()
    return s.get(key)
  }),
  'db.run': typed(async ({ sql, paramsJson }: { sql: string; paramsJson: string }) => {
    const wasm = await loadWasm(DB_NAME)
    wasm.run(sql, paramsJson)
  }),
  'db.query': typed(async ({ sql, paramsJson }: { sql: string; paramsJson: string }) => {
    const wasm = await loadWasm(DB_NAME)
    return JSON.parse(wasm.query(sql, paramsJson)) as unknown
  }),
})
