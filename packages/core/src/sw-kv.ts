import type { KvLike } from './core/sync'
import { IdbStorage } from './core/storage'
import { createStorageGuard } from './core/storage/locks'

/**
 * Service-worker KV backed by the same IndexedDB `oxelot`/`kv` store the worker
 * uses, so the page-side queue (proxied through the pool) and the SW-side queue
 * are one shared, origin-wide queue. A flush from either context drains the same
 * envelopes (consumer-side idempotency by `id` guards concurrent drains).
 *
 * Every read/write runs under the `oxelot-storage:<key>` Web Lock (M2.3) so the
 * SW's checkpoint writes serialize with worker-side kv writes on the same key.
 */
export class WorkerKv implements KvLike {
  private readonly storage = new IdbStorage()
  private readonly guard = createStorageGuard(
    (globalThis as unknown as { navigator?: { locks?: LockManager } }).navigator?.locks,
  )

  async get<T>(key: string): Promise<T | null> {
    return this.guard.withLock(key, () => this.storage.get<T>(key))
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.guard.withLock(key, () => this.storage.set(key, value))
  }
}
