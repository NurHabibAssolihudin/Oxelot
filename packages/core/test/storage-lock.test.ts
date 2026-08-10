import { describe, it, expect } from 'vitest'
import { createStorageGuard, storageLockName } from '../src/core/storage/locks'

// Node has no Web Locks API; emulate the exclusive per-origin lock set a browser
// provides across realms. Two `createStorageGuard` instances sharing one locker
// model two realms (e.g. worker and service worker) contending on the same name.
class MockLocker {
  private readonly held = new Set<string>()
  private readonly waiters: Array<{ name: string; kick: () => void }> = []
  private readonly requested: string[] = []

  get requestedNames(): readonly string[] {
    return this.requested
  }

  request(name: string, ...rest: unknown[]): Promise<unknown> {
    const options = (typeof rest[0] === 'object' && rest[0] ? rest[0] : {}) as { ifAvailable?: boolean }
    const fn = (typeof rest[0] === 'function' ? rest[0] : rest[1]) as () => unknown
    this.requested.push(name)
    return new Promise<unknown>((resolve, reject) => {
      const attempt = (): void => {
        if (this.held.has(name)) {
          if (options.ifAvailable === true) {
            resolve(undefined)
            return
          }
          this.waiters.push({ name, kick: attempt })
          return
        }
        this.held.add(name)
        void (async () => {
          try {
            resolve(await fn())
          } catch (err) {
            reject(err instanceof Error ? err : new Error(String(err)))
          } finally {
            this.held.delete(name)
            const idx = this.waiters.findIndex((w) => w.name === name)
            const next = idx === -1 ? undefined : this.waiters.splice(idx, 1)[0]
            next?.kick()
          }
        })()
      }
      attempt()
    })
  }
}

const mockLockManager = (locker: MockLocker): LockManager => locker as unknown as LockManager

describe('StorageGuard (M2.3 slice 3.1)', () => {
  it('prepends the oxelot-storage: namespace to the requested lock name', async () => {
    const locker = new MockLocker()
    const guard = createStorageGuard(mockLockManager(locker))
    await guard.withLock('orders', async () => 'ok')
    expect(locker.requestedNames).toEqual(['oxelot-storage:orders'])
    expect(storageLockName('orders')).toBe('oxelot-storage:orders')
  })

  it('serializes concurrent writers from different realms on the same name', async () => {
    const locker = new MockLocker()
    const realmA = createStorageGuard(mockLockManager(locker))
    const realmB = createStorageGuard(mockLockManager(locker))
    const events: string[] = []

    const a = realmA.withLock('queue', async () => {
      events.push('a-start')
      await new Promise((r) => setTimeout(r, 25))
      events.push('a-end')
    })
    const b = realmB.withLock('queue', async () => {
      events.push('b-start')
      events.push('b-end')
    })

    await Promise.all([a, b])
    expect(events).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('does not interleave two writes to the same file name', async () => {
    const locker = new MockLocker()
    const guard = createStorageGuard(mockLockManager(locker))
    const log: string[] = []

    const w1 = guard.withLock('db.sqlite', async () => {
      log.push('w1-write')
      await new Promise((r) => setTimeout(r, 20))
      log.push('w1-done')
    })
    const w2 = guard.withLock('db.sqlite', async () => {
      log.push('w2-write')
      log.push('w2-done')
    })

    await Promise.all([w1, w2])
    expect(log).toEqual(['w1-write', 'w1-done', 'w2-write', 'w2-done'])
  })

  it('runs the callback directly when Web Locks are unavailable', async () => {
    const guard = createStorageGuard(undefined)
    expect(guard.isSupported).toBe(false)
    const value = await guard.withLock('anything', async () => 42)
    expect(value).toBe(42)
  })

  it('releases the lock even when the callback throws', async () => {
    const locker = new MockLocker()
    const guard = createStorageGuard(mockLockManager(locker))
    await expect(guard.withLock('kv', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    // The failed write must not wedge the lock for the next writer.
    const next = await guard.withLock('kv', async () => 'ok')
    expect(next).toBe('ok')
  })

  it('guards reads the same way as writes (no partial state)', async () => {
    const locker = new MockLocker()
    const guard = createStorageGuard(mockLockManager(locker))
    const seen: string[] = []
    const write = guard.withLock('file', async () => {
      seen.push('w')
      await new Promise((r) => setTimeout(r, 20))
    })
    const read = guard.withLock('file', async () => {
      seen.push('r')
    })
    await Promise.all([write, read])
    // The read cannot observe mid-write state: it runs strictly after the write.
    expect(seen).toEqual(['w', 'r'])
  })
})
