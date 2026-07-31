import { describe, it, expect, vi } from 'vitest'
import { OxelotBridge } from '../src/core/pool/bridge'
import type { OxelotMessage } from '../src/core/pool/bridge'

class MockWorker {
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  posted: { message: OxelotMessage; transfer?: ArrayBuffer[] | undefined }[] = []

  addEventListener(type: string, cb: (ev: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? []
    list.push(cb)
    this.listeners.set(type, list)
  }

  postMessage(message: OxelotMessage, transfer?: ArrayBuffer[]): void {
    this.posted.push({ message, transfer })
  }

  respond(response: OxelotMessage): void {
    for (const cb of this.listeners.get('message') ?? []) {
      cb({ data: response } as MessageEvent)
    }
  }

  terminate(): void {}
}

describe('OxelotBridge', () => {
  it('resolves requests matched by id', async () => {
    const worker = new MockWorker()
    const bridge = new OxelotBridge(worker as unknown as Worker)
    const p = bridge.request<string>('op.a')
    const first = worker.posted[0]
    expect(first?.message.kind).toBe('request')
    const id = first?.message.kind === 'request' ? first.message.id : ''
    worker.respond({ kind: 'response', id, ok: true, result: 'hello' })
    await expect(p).resolves.toBe('hello')
  })

  it('rejects with OxelotError code on failed response', async () => {
    const worker = new MockWorker()
    const bridge = new OxelotBridge(worker as unknown as Worker)
    const p = bridge.request('op.b')
    const first = worker.posted[0]
    const id = first?.message.kind === 'request' ? first.message.id : ''
    worker.respond({ kind: 'response', id, ok: false, error: { code: 'ERR_FILE_NOT_FOUND', message: 'nope' } })
    await expect(p).rejects.toMatchObject({ code: 'ERR_FILE_NOT_FOUND' })
  })

  it('times out after the configured timeout', async () => {
    const worker = new MockWorker()
    const bridge = new OxelotBridge(worker as unknown as Worker, 20)
    await expect(bridge.request('op.c')).rejects.toMatchObject({ code: 'ERR_BRIDGE_TIMEOUT' })
  })

  it('fans out events to subscribers', async () => {
    const worker = new MockWorker()
    const bridge = new OxelotBridge(worker as unknown as Worker)
    const spy = vi.fn()
    const off = bridge.onEvent(spy)
    worker.respond({ kind: 'event', name: 'storage-change', payload: { key: 'x' } })
    expect(spy).toHaveBeenCalledWith('storage-change', { key: 'x' })
    off()
    worker.respond({ kind: 'event', name: 'storage-change', payload: { key: 'y' } })
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('ignores responses with unknown ids', async () => {
    const worker = new MockWorker()
    const bridge = new OxelotBridge(worker as unknown as Worker)
    worker.respond({ kind: 'response', id: 'does-not-exist', ok: true, result: 1 })
    expect(bridge.pendingCount).toBe(0)
  })
})
