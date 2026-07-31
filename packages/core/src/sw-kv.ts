import type { KvLike } from './core/sync'

function getCache(): Promise<Cache | undefined> {
  return caches.open('oxelot-sync').catch(() => undefined)
}

const KEY_PREFIX = 'oxelot.sync.'

/**
 * Service-worker KV backed by the Cache Storage API. Envelopes are stored as
 * opaque blobs keyed by name. Mirrors the KvLike contract used by the queue.
 */
export class WorkerKv implements KvLike {
  async get<T>(key: string): Promise<T | null> {
    const cache = await getCache()
    if (!cache) return null
    const res = await cache.match(KEY_PREFIX + key)
    if (!res) return null
    const text = await res.text()
    try {
      return JSON.parse(text) as T
    } catch {
      return null
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    const cache = await getCache()
    if (!cache) return
    const blob = new Blob([JSON.stringify(value)], { type: 'application/json' })
    await cache.put(KEY_PREFIX + key, new Response(blob))
  }
}
