import { describe, it, expect } from 'vitest'
import { OxelotPool } from '../src/core/pool/pool'
import type { OxelotMessage } from '../src/core/pool/bridge'

type RequestMessage = Extract<OxelotMessage, { kind: 'request' }>

class ControlledWorker {
  posted: OxelotMessage[] = []
  private readonly listeners = new Map<string, ((ev: Event | MessageEvent) => void)[]>()
  crashOnRequest = false

  addEventListener(type: string, cb: (ev: Event | MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }

  postMessage(message: OxelotMessage): void {
    if (message.kind !== 'request') return
    this.posted.push(message)
    if (message.op === 'config') {
      this.respond(message.id)
      return
    }
    if (this.crashOnRequest) {
      this.crashOnRequest = false
      queueMicrotask(() => this.fireError())
      return
    }
    this.respond(message.id)
  }

  respond(id: string): void {
    queueMicrotask(() => {
      for (const cb of this.listeners.get('message') ?? []) {
        ;(cb as (ev: MessageEvent) => void)({
          data: { kind: 'response', id, ok: true, result: null },
        } as MessageEvent)
      }
    })
  }

  fireError(): void {
    for (const cb of this.listeners.get('error') ?? []) {
      ;(cb as (ev: ErrorEvent) => void)({ message: 'boom' } as ErrorEvent)
    }
  }

  terminate(): void {}
}

interface Harness {
  pool: OxelotPool
  created: ControlledWorker[][]
}

function harness(concurrency: number, crashSlot?: number): Harness {
  const created: ControlledWorker[][] = []
  const pool = new OxelotPool((i) => {
    const w = new ControlledWorker()
    if (crashSlot !== undefined && i === crashSlot && (created[i] ?? []).length === 0) {
      w.crashOnRequest = true
    }
    ;(created[i] ??= []).push(w)
    return w as unknown as Worker
  }, concurrency)
  return { pool, created }
}

describe('OxelotPool crash respawn', () => {
  it('re-dispatches an in-flight request once to the respawned worker', async () => {
    const { pool, created } = harness(2, 0)
    await pool.start({ dbName: 'db', storageBackend: 'indexeddb', sourceTab: 'tab' })

    const result = await pool.request('ping')

    expect(result).toBeNull()
    // First worker of slot 0 crashed; a second worker must have been respawned.
    expect(created[0]!.length).toBe(2)
    const errored = created[0]![0]!.posted.map((m) => (m as RequestMessage).op)
    const respawned = created[0]![1]!.posted.map((m) => (m as RequestMessage).op)
    expect(errored[0]).toBe('config')
    expect(respawned[0]).toBe('config') // respawn re-broadcasts config
    // The unpinned ping is re-dispatched to whichever slot is available.
    const delivered = created.flat().some((w) => w.posted.some((m) => (m as RequestMessage).op === 'ping'))
    expect(delivered).toBe(true)
    await pool.dispose()
  })

  it('rejects with ERR_WORKER_SPAWN when a request survives one crash and crashes again', async () => {
    const created: ControlledWorker[][] = []
    const pool = new OxelotPool((i) => {
      const w = new ControlledWorker()
      // Crash on the first request for the first TWO instances of slot 0.
      if (i === 0 && (created[0] ?? []).length < 2) w.crashOnRequest = true
      ;(created[i] ??= []).push(w)
      return w as unknown as Worker
    }, 2)
    await pool.start()

    await expect(pool.request('ping', undefined, { worker: 0 })).rejects.toMatchObject({
      code: 'ERR_WORKER_SPAWN',
    })
    // Slot 0 now has its third worker (two crashed, one respawned) alive.
    expect(created[0]!.length).toBe(3)
    await pool.dispose()
  })

  it('emits worker-error events on crash', async () => {
    const { pool } = harness(1, 0)
    const errors: string[] = []
    pool.onEvent((ev) => {
      if (ev.type === 'worker-error') errors.push(ev.message)
    })
    await pool.start()

    await pool.request('ping').catch(() => undefined)

    expect(errors.length).toBeGreaterThanOrEqual(1)
    expect(errors).toContain('boom')
    await pool.dispose()
  })

  it('keeps db ops pinned to the respawned worker 0', async () => {
    const { pool, created } = harness(2, 0)
    await pool.start()

    await pool.request('db.run', { sql: 'CREATE', paramsJson: '[]' }, { worker: 0 })

    const respawned = created[0]![1]!
    const ops = respawned.posted.map((m) => (m as RequestMessage).op)
    expect(ops).toContain('db.run')
    await pool.dispose()
  })
})
