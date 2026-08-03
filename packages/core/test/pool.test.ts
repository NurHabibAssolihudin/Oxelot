import { describe, it, expect } from 'vitest'
import { OxelotPool } from '../src/core/pool/pool'
import type { OxelotMessage } from '../src/core/pool/bridge'
import { createWorkerStorage } from '../src/core/storage'

class AutoRespondWorker {
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  posted: { message: OxelotMessage; transfer?: ArrayBuffer[] | undefined }[] = []

  addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }

  postMessage(message: OxelotMessage, transfer?: ArrayBuffer[]): void {
    this.posted.push({ message, transfer })
    if (message.kind === 'request') {
      queueMicrotask(() => {
        for (const cb of this.listeners.get('message') ?? []) {
          cb({ data: { kind: 'response', id: message.id, ok: true, result: null } } as MessageEvent)
        }
      })
    }
  }

  terminate(): void {}
}

describe('OxelotPool', () => {
  it('broadcasts op config to every worker at start, before any request', async () => {
    const workers = [new AutoRespondWorker(), new AutoRespondWorker()]
    const pool = new OxelotPool((i) => workers[i]! as unknown as Worker, 2)

    await pool.start({ dbName: 'catalog.db', storageBackend: 'indexeddb', dbEnabled: false, sourceTab: 'tab-x' })
    await pool.request('ping')

    for (const w of workers) {
      const first = w.posted[0]
      expect(first?.message.kind).toBe('request')
      if (first?.message.kind === 'request') {
        expect(first.message.op).toBe('config')
        expect(first.message.payload).toEqual({
          dbName: 'catalog.db',
          storageBackend: 'indexeddb',
          dbEnabled: false,
          sourceTab: 'tab-x',
        })
      }
    }

    const opsByWorker = workers.map((w) =>
      w.posted
        .map((p) => p.message)
        .filter((m): m is Extract<OxelotMessage, { kind: 'request' }> => m.kind === 'request')
        .map((m) => m.op),
    )
    for (const ops of opsByWorker) {
      expect(ops[0]).toBe('config')
    }
    const allOps = opsByWorker.flat()
    expect(allOps).toContain('ping')
    expect(allOps.filter((op) => op === 'config')).toHaveLength(2)

    await pool.dispose()
  })

  it('skips config when start is called without config', async () => {
    const worker = new AutoRespondWorker()
    const pool = new OxelotPool(() => worker as unknown as Worker, 1)

    await pool.start()
    await pool.request('ping')

    const first = worker.posted[0]
    if (first?.message.kind === 'request') {
      expect(first.message.op).toBe('ping')
    }

    await pool.dispose()
  })

  it('pins db ops to worker 0 while untargeted ops still dispatch', async () => {
    const workers = [new AutoRespondWorker(), new AutoRespondWorker()]
    const pool = new OxelotPool((i) => workers[i]! as unknown as Worker, 2)

    await pool.start()

    await Promise.all([
      pool.request('db.run', { sql: 'CREATE', paramsJson: '[]' }, { worker: 0 }),
      pool.request('ping'),
      pool.request('db.query', { sql: 'SELECT', paramsJson: '[]' }, { worker: 0 }),
      pool.request('ping'),
    ])

    const dbWorkers = workers.map((w) =>
      w.posted.filter(
        (p): p is { message: Extract<OxelotMessage, { kind: 'request' }>; transfer?: ArrayBuffer[] } =>
          p.message.kind === 'request' && (p.message.op === 'db.run' || p.message.op === 'db.query'),
      ),
    )
    expect(dbWorkers[0]!.length).toBeGreaterThanOrEqual(2)
    expect(dbWorkers[1]!.length).toBe(0)

    // Untargeted pings are still dispatched (to whichever worker is free; the
    // pinned db ops saturate worker 0, so they land on worker 1 here).
    const pingCount = workers.reduce(
      (n, w) => n + w.posted.filter((p) => p.message.kind === 'request' && p.message.op === 'ping').length,
      0,
    )
    expect(pingCount).toBe(2)

    await pool.dispose()
  })
})

describe('createWorkerStorage', () => {
  it('selects the indexeddb backend when requested', async () => {
    const storage = await createWorkerStorage('indexeddb')
    expect(storage.backend).toBe('indexeddb')
  })

  it('defaults to indexeddb outside a worker scope (auto)', async () => {
    const storage = await createWorkerStorage('auto')
    expect(storage.backend).toBe('indexeddb')
  })
})
