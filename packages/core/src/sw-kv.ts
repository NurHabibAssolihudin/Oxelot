import type { KvLike } from './core/sync'
import { IdbStorage } from './core/storage'

/**
 * Service-worker KV backed by the same IndexedDB `oxelot`/`kv` store the worker
 * uses, so the page-side queue (proxied through the pool) and the SW-side queue
 * are one shared, origin-wide queue. A flush from either context drains the same
 * envelopes (consumer-side idempotency by `id` guards concurrent drains).
 */
export class WorkerKv implements KvLike {
  private readonly storage = new IdbStorage()

  async get<T>(key: string): Promise<T | null> {
    return this.storage.get<T>(key)
  }

  async set<T>(key: string, value: T): Promise<void> {
    await this.storage.set(key, value)
  }
}
