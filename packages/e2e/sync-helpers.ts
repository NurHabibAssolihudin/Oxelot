import type { Page } from '@playwright/test'

export const QUEUE_KEY = 'oxelot.sync.queue'
// Same-origin endpoint served by the playground dev server. Chromium service
// workers can fetch same-origin reliably (cross-origin and loopback-IP fetches
// are blocked in headless), so the SW flushes here and the test reads the log.
export const SYNC_ENDPOINT = 'http://localhost:5199/__oxelot_sync'

export async function resetSyncLog(page: Page): Promise<void> {
  await page.request.delete(SYNC_ENDPOINT)
}

export async function readSyncLog(page: Page): Promise<string[]> {
  const res = await page.request.get(SYNC_ENDPOINT)
  return (await res.json()) as string[]
}

export interface OxelotLike {
  sync: {
    enqueue(m: Record<string, unknown>): Promise<void>
    status(): Promise<{ pending: number; deadLetters: number }>
  }
  registerServiceWorker(): Promise<void>
  dispose(): Promise<void>
}

export interface OxelotCtor {
  init(cfg: Record<string, unknown>): Promise<OxelotLike>
}

export interface TestWindow extends Window {
  __oxelot?: { Oxelot: OxelotCtor }
}

export async function waitForSwActive(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => (await navigator.serviceWorker.ready).active?.state === 'activated',
    undefined,
    { timeout: 10_000 },
  )
}

export async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 5000 })
}

/** Post `oxelot-sync` to the active SW and resolve with the flush result. */
export async function triggerSwFlush(page: Page): Promise<unknown> {
  return page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    const sw = reg.active
    if (!sw) throw new Error('no active SW')
    const result = await new Promise<unknown>((resolvePromise) => {
      const onMsg = (ev: MessageEvent): void => {
        const data = ev.data as { type?: string } | undefined
        if (data?.type === 'oxelot-sync-result') {
          navigator.serviceWorker.removeEventListener('message', onMsg)
          resolvePromise(data)
        }
      }
      navigator.serviceWorker.addEventListener('message', onMsg)
      sw.postMessage({ type: 'oxelot-sync' })
    })
    return result
  })
}

/** Seed the shared IndexedDB queue with two pending envelopes (no page sync). */
export async function seedQueue(page: Page): Promise<void> {
  await page.evaluate(async ({ queueKey, now }) => {
    const db = await new Promise<IDBDatabase>((resolvePromise, rejectPromise) => {
      const req = indexedDB.open('oxelot', 1)
      req.onsuccess = () => resolvePromise(req.result)
      req.onerror = () => rejectPromise(new Error('failed to open IndexedDB'))
    })
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put({
      key: queueKey,
      value: [
        {
          id: 'sync-1',
          schemaVersion: 1,
          collection: 'todos',
          op: 'upsert',
          payload: { title: 'beta' },
          createdAt: now,
          attempts: 0,
        },
        {
          id: 'sync-2',
          schemaVersion: 1,
          collection: 'todos',
          op: 'delete',
          payload: { id: 9 },
          createdAt: now + 1,
          attempts: 0,
        },
      ],
    })
    await new Promise<void>((resolvePromise) => {
      tx.oncomplete = () => resolvePromise()
    })
  }, { queueKey: QUEUE_KEY, now: Date.now() })
}

/** Seed the shared IndexedDB queue with `n` pending envelopes (no page sync). */
export async function seedQueueN(page: Page, n: number): Promise<void> {
  await page.evaluate(async ({ queueKey, count }) => {
    const db = await new Promise<IDBDatabase>((resolvePromise, rejectPromise) => {
      const req = indexedDB.open('oxelot', 1)
      req.onsuccess = () => resolvePromise(req.result)
      req.onerror = () => rejectPromise(new Error('failed to open IndexedDB'))
    })
    const now = Date.now()
    const envelopes = Array.from({ length: count }, (_, i) => ({
      id: `soak-${i}`,
      schemaVersion: 1,
      collection: 'todos',
      op: 'upsert',
      payload: { i },
      createdAt: now + i,
      attempts: 0,
    }))
    const tx = db.transaction('kv', 'readwrite')
    tx.objectStore('kv').put({ key: queueKey, value: envelopes })
    await new Promise<void>((resolvePromise) => {
      tx.oncomplete = () => resolvePromise()
    })
  }, { queueKey: QUEUE_KEY, count: n })
}