import { describe, it, expect, vi } from 'vitest'
import { PersistentSyncQueue } from '../src/core/sync/queue'
import type { OxelotMutation } from '../src/core/sync/envelope'

class MemoryKv {
  private store = new Map<string, string>()
  async get<T>(key: string): Promise<T | null> {
    const raw = this.store.get(key)
    return raw === undefined ? null : (JSON.parse(raw) as T)
  }
  async set<T>(key: string, value: T): Promise<void> {
    this.store.set(key, JSON.stringify(value))
  }
}

const makeMutation = (id: string): OxelotMutation => ({
  id,
  schemaVersion: 1,
  collection: 'orders',
  op: 'upsert',
  payload: { id },
  createdAt: Date.now(),
  attempts: 0,
})

describe('PersistentSyncQueue', () => {
  it('persists envelopes before resolving enqueue', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('a'))
    const { pending } = await queue.status()
    expect(pending).toBe(1)
    expect(deliver).not.toHaveBeenCalled()
  })

  it('delivers and drains on flush', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('a'))
    await queue.enqueue(makeMutation('b'))
    const result = await queue.flush()
    expect(result.delivered).toBe(2)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect((await queue.status()).pending).toBe(0)
  })

  it('quarantines failures that exceed the retry budget as dead letters', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockRejectedValue(new Error('network down'))
    const queue = new PersistentSyncQueue(kv, { deliver })
    const bad = makeMutation('x')
    bad.attempts = 4 // next attempt = 5 → dead letter
    await queue.enqueue(bad)
    const result = await queue.flush()
    expect(result.deadLetters).toBe(1)
    const { pending, deadLetters } = await queue.status()
    expect(pending).toBe(0)
    expect(deadLetters).toBe(1)
  })

  it('keeps envelopes for retry on transient failure', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockRejectedValue(new Error('network down'))
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('a'))
    const result = await queue.flush()
    expect(result.delivered).toBe(0)
    expect(result.deadLetters).toBe(0)
    expect((await queue.status()).pending).toBe(1)
  })

  it('emits state transitions', async () => {
    const kv = new MemoryKv()
    const queue = new PersistentSyncQueue(kv, { deliver: vi.fn().mockResolvedValue(undefined) })
    const states: string[] = []
    queue.onStateChange((s) => states.push(s.kind))
    await queue.enqueue(makeMutation('a'))
    await queue.flush()
    expect(states).toEqual(['queued', 'syncing', 'idle'])
  })

  it('does not allow concurrent flush', async () => {
    const kv = new MemoryKv()
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => (release = r))
    const deliver = vi.fn(async () => {
      await gate
    })
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('a'))
    const first = queue.flush()
    const second = await queue.flush() // returns immediately without delivering
    expect(second.delivered).toBe(0)
    release()
    const result = await first
    expect(result.delivered).toBe(1)
  })
})
