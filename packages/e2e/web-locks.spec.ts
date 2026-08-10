import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import {
  resetSyncLog,
  readSyncLog,
  seedQueueN,
  triggerSwFlush,
  waitForController,
  waitForSwActive,
  SYNC_ENDPOINT,
} from './sync-helpers'
import type { TestWindow } from './sync-helpers'

/** Hold an `oxelot-storage:<name>`-style lock from the page realm until released. */
async function holdLock(page: Page, name: string): Promise<void> {
  await page.evaluate(
    async (lockName) => {
      const w = window as { __lockRelease?: () => void }
      let release: () => void = () => undefined
      const hold = new Promise<void>((r) => (release = r))
      w.__lockRelease = release
      void navigator.locks.request(lockName, () => hold)
      // Wait until the lock is actually granted before returning, so callers
      // that then contend on the same name deterministically queue behind it.
      const deadline = Date.now() + 2000
      while (Date.now() < deadline) {
        const snap = await navigator.locks.query()
        if ((snap.held ?? []).some((l) => l.name === lockName)) return
        await new Promise((r) => setTimeout(r, 10))
      }
      throw new Error(`lock never granted: ${lockName}`)
    },
    name,
  )
}

async function releaseLock(page: Page): Promise<number> {
  return page.evaluate(() => {
    ;(window as { __lockRelease?: () => void }).__lockRelease?.()
    return Date.now()
  })
}

async function boot(page: Page, sync?: boolean): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
  await page.evaluate(
    async ({ useSync, serverUrl }) => {
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({
        workers: 1,
        ...(useSync ? { sync: { serverUrl }, registerSW: true } : {}),
      })
      ;(window as { __w?: unknown }).__w = oxelot
    },
    { useSync: sync === true, serverUrl: SYNC_ENDPOINT },
  )
}

test('3.1 a worker-side kv write queues behind the oxelot-storage lock', async ({ page }) => {
  await boot(page)

  // The page realm holds the storage lock for key "probe"…
  await holdLock(page, 'oxelot-storage:probe')

  // …so the worker-side write to the same key must wait for the lock, proving
  // the worker's kv WRITE participates in the cross-realm lock set (M2.3 3.1).
  await page.evaluate(() => {
    const ox = (window as { __w?: { storage: { set(k: string, v: unknown): Promise<void> } } }).__w!
    ;(window as { __setPending?: Promise<void> }).__setPending = ox.storage.set('probe', { n: 1 })
  })

  const stillPending = await page.evaluate(
    () =>
      new Promise<boolean>((resolvePending) => {
        const p = (window as { __setPending?: Promise<void> }).__setPending
        if (!p) {
          resolvePending(false)
          return
        }
        let settled = false
        p.then(() => {
          settled = true
          resolvePending(false)
        }).catch(() => {
          settled = true
          resolvePending(false)
        })
        setTimeout(() => {
          if (!settled) resolvePending(true)
        }, 300)
      }),
  )
  expect(stillPending).toBe(true)

  // Releasing the lock lets the queued write complete.
  await releaseLock(page)
  await page.evaluate(() => (window as { __setPending?: Promise<void> }).__setPending)
  const value = await page.evaluate(async () => {
    const ox = (window as { __w?: { storage: { get<T>(k: string): Promise<T | null> } } }).__w!
    return ox.storage.get<{ n: number }>('probe')
  })
  expect(value).toEqual({ n: 1 })
})

test('3.2 lock release invalidates a sibling tab via storage-change <= 100ms', async ({ page, context }) => {
  const pageA = page
  const pageB = await context.newPage()
  await boot(pageA)
  await boot(pageB)

  // Tab B records storage-change events with wall-clock timestamps.
  await pageB.evaluate(async () => {
    const w = window as {
      __w?: { on(cb: (ev: { type?: string; key?: string }) => void): () => void }
      __rel?: Array<{ key: string; at: number }>
    }
    w.__rel = []
    const oxelot = w.__w
    oxelot?.on((ev) => {
      if (ev.type === 'storage-change' && ev.key) {
        w.__rel!.push({ key: ev.key, at: Date.now() })
      }
    })
  })

  // Tab A holds the storage lock for "order"; the queued write only completes
  // when the lock is released — so B's invalidation is release-driven.
  await holdLock(pageA, 'oxelot-storage:order')
  await pageA.evaluate(() => {
    const ox = (window as { __w?: { storage: { set(k: string, v: unknown): Promise<void> } } }).__w!
    void ox.storage.set('order', { status: 'done' })
  })

  const releasedAt = await releaseLock(pageA)
  await pageA.evaluate(async () => {
    const ox = (window as { __w?: { storage: { get<T>(k: string): Promise<T | null> } } }).__w!
    await ox.storage.get('order')
  })

  await pageB.waitForFunction(
    (t0) => (window as { __rel?: Array<{ key: string; at: number }> }).__rel?.some((e) => e.key === 'order' && e.at >= t0) ?? false,
    releasedAt,
    { timeout: 2000 },
  )
  const latency = await pageB.evaluate(() => {
    const rel = (window as { __rel?: Array<{ key: string; at: number }> }).__rel ?? []
    const last = rel.filter((e) => e.key === 'order')[rel.length - 1]
    return last?.at ?? -1
  })
  expect(latency).toBeGreaterThanOrEqual(releasedAt)
  expect(latency - releasedAt).toBeLessThan(100)
})

test('3.3 two tabs + SW contention: exactly one flusher drains without duplicates', async ({
  page,
  context,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Web Locks + SW contention is Chromium-only')
  const pageA = page
  const pageB = await context.newPage()
  await boot(pageA, true)
  await boot(pageB, true)
  await waitForSwActive(pageA)
  await waitForController(pageA)
  await resetSyncLog(pageA)

  // Re-send the config (idempotent) so the SW's queue is definitely wired.
  await pageA.evaluate(async ({ serverUrl }) => {
    const reg = await navigator.serviceWorker.ready
    reg.active?.postMessage({ type: 'oxelot-config', serverUrl })
  }, { serverUrl: SYNC_ENDPOINT })

  await seedQueueN(pageA, 20)

  // Three contexts race to drain the shared queue at once; the `oxelot-sync`
  // Web Lock admits only one active flusher.
  const [ra, rb, rsw] = await Promise.all([
    pageA.evaluate(async () => {
      const ox = (window as { __w?: { sync: { flush(): Promise<{ delivered: number; deadLetters: number }> } } }).__w!
      return ox.sync.flush()
    }),
    pageB.evaluate(async () => {
      const ox = (window as { __w?: { sync: { flush(): Promise<{ delivered: number; deadLetters: number }> } } }).__w!
      return ox.sync.flush()
    }),
    triggerSwFlush(pageA),
  ])

  const delivered = ra.delivered + rb.delivered + ((rsw as { delivered?: number }).delivered ?? 0)
  // The exclusive `oxelot-sync` lock admits exactly one active flusher at a
  // time; the losers wait, then no-op on the already-drained queue, so the sum
  // of delivered equals the queue size (double-delivery would inflate it).
  expect(delivered).toBe(20)

  const bodies = await readSyncLog(pageA)
  expect(bodies.length).toBe(20)
  const ids = bodies.map((b) => (JSON.parse(b) as { id?: string }).id)
  expect(new Set(ids).size).toBe(20)

  const status = await pageA.evaluate(async () => {
    const ox = (window as { __w?: { sync: { status(): Promise<{ pending: number; deadLetters: number }> } } }).__w!
    return ox.sync.status()
  })
  expect(status).toEqual({ pending: 0, deadLetters: 0 })
})