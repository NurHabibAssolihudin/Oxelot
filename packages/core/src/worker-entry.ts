import { handleMessages } from './core/pool/worker-handler'
import { createWorkerStorage } from './core/storage'
import type { WorkerStorageFacade } from './core/storage'
import { loadWasm } from './wasm'
import { oxError } from './errors'

let DB_NAME = 'oxelot.db'

self.addEventListener('message', (ev: MessageEvent) => {
  const msg = ev.data as { kind?: string; dbName?: string } | undefined
  if (msg?.kind === 'config' && typeof msg.dbName === 'string') DB_NAME = msg.dbName
})

async function main(): Promise<void> {
  let storage: WorkerStorageFacade | null = null

  try {
    storage = await createWorkerStorage()
  } catch (err) {
    self.postMessage({
      kind: 'response' as const,
      id: '__bootstrap_error__',
      ok: false,
      error: {
        code: err instanceof Error ? (err as Error & { code?: string }).code ?? 'ERR_UNKNOWN' : 'ERR_UNKNOWN',
        message: err instanceof Error ? err.message : String(err),
      },
    })
  }

  const s = (): WorkerStorageFacade => {
    if (!storage) throw oxError('ERR_UNKNOWN', 'storage failed to initialize')
    return storage
  }

  const typed =
    <T>(fn: (payload: T, transfer?: ArrayBuffer[]) => unknown | Promise<unknown>) =>
    (payload: unknown, transfer?: ArrayBuffer[]) =>
      fn(payload as T, transfer)

  handleMessages({
    'ping': async () => {
      return null
    },
    'storage.readBytes': typed(async ({ name, offset, length }: { name: string; offset: number; length: number }) => {
      const f = await s().open(name, 'read')
      const data = await f.readBytes(offset, length)
      await f.close()
      return data.buffer
    }),
    'storage.writeBytes': typed(
      async ({ name, offset, data }: { name: string; offset: number; data: Uint8Array }) => {
        const f = await s().open(name, 'readwrite')
        await f.writeBytes(offset, data)
        await f.sync()
        await f.close()
      },
    ),
    'storage.truncate': typed(async ({ name, size }: { name: string; size: number }) => {
      const f = await s().open(name, 'readwrite')
      await f.truncate(size)
      await f.sync()
      await f.close()
    }),
    'storage.getSize': typed(async ({ name }: { name: string }) => {
      const f = await s().open(name, 'read')
      const size = await f.size()
      await f.close()
      return size
    }),
    'storage.remove': typed(async ({ name }: { name: string }) => {
      await s().remove(name)
    }),
    'storage.entries': async () => {
      return s().entries()
    },
    'kv.set': typed(async ({ key, value }: { key: string; value: unknown }) => {
      await s().set(key, value)
    }),
    'kv.get': typed(async ({ key }: { key: string }) => {
      return s().get(key)
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
}

void main()
