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

describe('PersistentSyncQueue backoff scheduling', () => {
  it('delivers only envelopes that are due', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const queue = new PersistentSyncQueue(kv, { deliver })
    const due = makeMutation('due')
    const future = makeMutation('future')
    future.nextRetryAt = Date.now() + 60_000
    await queue.enqueue(due)
    await queue.enqueue(future)

    const result = await queue.flush()

    expect(result.delivered).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect((await queue.status()).pending).toBe(1) // future envelope kept
  })

  it('stamps nextRetryAt on transient failure and does not redeliver before the window', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockRejectedValue(new Error('network down'))
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('a'))

    await queue.flush()
    const stored = await kv.get<OxelotMutation[]>('oxelot.sync.queue')
    expect(stored?.[0]?.attempts).toBe(1)
    expect(stored?.[0]?.nextRetryAt).toBeGreaterThan(Date.now())

    // A flush before the backoff window expires must not touch the envelope.
    const again = await queue.flush()
    expect(again.delivered).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(1)
    expect((await queue.status()).pending).toBe(1)
  })

  it('redelivers once the backoff window has elapsed', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValue(undefined)
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('a'))

    await queue.flush()
    const stored = await kv.get<OxelotMutation[]>('oxelot.sync.queue')
    const next = stored?.[0]?.nextRetryAt ?? 0

    // Simulate time passing past the scheduled window by rewriting nextRetryAt.
    const mutated = stored?.[0]
    if (mutated) {
      mutated.nextRetryAt = Date.now() - 1
      await kv.set('oxelot.sync.queue', [mutated])
    }

    const result = await queue.flush()
    expect(result.delivered).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(2)
    expect((await queue.status()).pending).toBe(0)
    void next
  })

  it('persists nextRetryAt across reloads (deserialize round-trip)', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockRejectedValue(new Error('network down'))
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('a'))
    await queue.flush()

    // Simulate a page reload: a fresh queue instance reads the same KV store.
    const reloaded = new PersistentSyncQueue(kv, { deliver })
    const { pending } = await reloaded.status()
    expect(pending).toBe(1)
    const stored = await kv.get<OxelotMutation[]>('oxelot.sync.queue')
    expect(stored?.[0]?.nextRetryAt).toBeGreaterThan(0)
  })
})

describe('PersistentSyncQueue exactly-once & peek (M2.2)', () => {
  it('deduplicates re-enqueued envelopes by stable id', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const queue = new PersistentSyncQueue(kv, { deliver })
    await queue.enqueue(makeMutation('dup'))
    await queue.enqueue(makeMutation('dup'))
    await queue.enqueue(makeMutation('dup'))
    const { pending } = await queue.status()
    expect(pending).toBe(1)
    const result = await queue.flush()
    expect(result.delivered).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('peek returns the next due envelope without removing it', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const queue = new PersistentSyncQueue(kv, { deliver })
    const future = makeMutation('future')
    future.nextRetryAt = Date.now() + 60_000
    await queue.enqueue(future)
    await queue.enqueue(makeMutation('due'))

    const next = await queue.peek()
    expect(next?.id).toBe('due')
    expect((await queue.status()).pending).toBe(2) // untouched
  })

  it('peek returns null when the queue is empty or every envelope is in backoff', async () => {
    const kv = new MemoryKv()
    const queue = new PersistentSyncQueue(kv, { deliver: vi.fn() })
    expect(await queue.peek()).toBeNull()

    const future = makeMutation('future')
    future.nextRetryAt = Date.now() + 60_000
    await queue.enqueue(future)
    expect(await queue.peek()).toBeNull()
  })

  it('removes each delivered envelope before the next is attempted (atomic pop, checkpoint=1)', async () => {
    const kv = new MemoryKv()
    // Capture the persisted queue state at the moment each delivery starts.
    const observed: string[] = []
    const deliver = vi.fn().mockImplementation(async (m: OxelotMutation) => {
      const q = await kv.get<OxelotMutation[]>('oxelot.sync.queue')
      observed.push((q ?? []).map((x) => x.id).join(','))
      void m
    })
    const queue = new PersistentSyncQueue(kv, { deliver }, undefined, { checkpoint: 1 })
    await queue.enqueue(makeMutation('a'))
    await queue.enqueue(makeMutation('b'))
    await queue.enqueue(makeMutation('c'))

    const result = await queue.flush()
    expect(result.delivered).toBe(3)
    // 'a' is persisted as drained before 'b' is attempted, and 'b' before 'c'.
    expect(observed).toEqual(['a,b,c', 'b,c', 'c'])
    expect((await queue.status()).pending).toBe(0)
  })

  it('pops only on success: a failed envelope stays queued while later ones drain', async () => {
    const kv = new MemoryKv()
    const deliver = vi
      .fn()
      .mockResolvedValueOnce(undefined) // 'a' ok
      .mockRejectedValueOnce(new Error('network down')) // 'b' transient
      .mockResolvedValueOnce(undefined) // 'c' ok
    const queue = new PersistentSyncQueue(kv, { deliver }, undefined, { checkpoint: 1 })
    await queue.enqueue(makeMutation('a'))
    await queue.enqueue(makeMutation('b'))
    await queue.enqueue(makeMutation('c'))

    const result = await queue.flush()
    expect(result.delivered).toBe(2)
    expect(result.deadLetters).toBe(0)
    const stored = await kv.get<OxelotMutation[]>('oxelot.sync.queue')
    expect(stored?.map((m) => m.id)).toEqual(['b'])
    expect(stored?.[0]?.nextRetryAt).toBeGreaterThan(Date.now())
  })
})

describe('PersistentSyncQueue 10k soak (1.4 shared-queue gate)', () => {
  it('drains 10k pre-seeded envelopes exactly once', async () => {
    const kv = new MemoryKv()
    const deliveredIds: string[] = []
    const deliver = vi.fn().mockImplementation(async (m: OxelotMutation) => {
      deliveredIds.push(m.id)
    })
    const queue = new PersistentSyncQueue(kv, { deliver })

    const seed: OxelotMutation[] = Array.from({ length: 10_000 }, (_, i) => ({
      ...makeMutation(`m-${i}`),
      createdAt: 1_000 + i,
    }))
    await kv.set('oxelot.sync.queue', seed)

    const result = await queue.flush()
    expect(result.delivered).toBe(10_000)
    expect(result.deadLetters).toBe(0)
    expect(deliver).toHaveBeenCalledTimes(10_000)
    expect(new Set(deliveredIds).size).toBe(10_000) // exactly once, no dupes
    const { pending, deadLetters } = await queue.status()
    expect(pending).toBe(0)
    expect(deadLetters).toBe(0)
  })
})

class FakeLock {
  isSupported = true
  private acquired = false
  async withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
    return fn()
  }
  async tryWithLock<T>(_name: string, fn: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    if (this.acquired) return { acquired: false }
    this.acquired = true
    try {
      return { acquired: true, result: await fn() }
    } finally {
      this.acquired = false
    }
  }
  async release(): Promise<void> {}
}

describe('PersistentSyncQueue Web Lock', () => {
  it('flushes when the oxelot-sync lock is free', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const queue = new PersistentSyncQueue(kv, { deliver }, new FakeLock())
    await queue.enqueue(makeMutation('a'))

    const result = await queue.flush()

    expect(result.delivered).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })

  it('skips the drain when another holder owns the lock', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const lock = new FakeLock()
    const queue = new PersistentSyncQueue(kv, { deliver }, lock)

    // Hold the lock externally, then flush: the queue must not deliver.
    await lock.tryWithLock('oxelot-sync', async () => {
      await queue.enqueue(makeMutation('a'))
      const result = await queue.flush()
      expect(result.delivered).toBe(0)
      expect(deliver).not.toHaveBeenCalled()
    })
  })

  it('does not deadlock the flushing guard across lock contention', async () => {
    const kv = new MemoryKv()
    const deliver = vi.fn().mockResolvedValue(undefined)
    const lock = new FakeLock()
    const queue = new PersistentSyncQueue(kv, { deliver }, lock)
    await queue.enqueue(makeMutation('a'))

    // Concurrent flushes: the second must return immediately, not hang.
    const [a, b] = await Promise.all([queue.flush(), queue.flush()])
    expect(a.delivered + b.delivered).toBe(1)
    expect(deliver).toHaveBeenCalledTimes(1)
  })
})
