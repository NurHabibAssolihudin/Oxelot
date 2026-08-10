import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'

const QUEUE_KEY = 'oxelot.sync.queue'
// Same-origin endpoint served by the playground dev server. Chromium service
// workers can fetch same-origin reliably (cross-origin and loopback-IP fetches
// are blocked in headless), so the SW flushes here and the test reads the log.
const SYNC_ENDPOINT = 'http://localhost:5199/__oxelot_sync'

async function resetSyncLog(page: Page): Promise<void> {
  await page.request.delete(SYNC_ENDPOINT)
}

async function readSyncLog(page: Page): Promise<string[]> {
  const res = await page.request.get(SYNC_ENDPOINT)
  return (await res.json()) as string[]
}

interface OxelotLike {
  sync: {
    enqueue(m: Record<string, unknown>): Promise<void>
    status(): Promise<{ pending: number; deadLetters: number }>
  }
  registerServiceWorker(): Promise<void>
  dispose(): Promise<void>
}

interface OxelotCtor {
  init(cfg: Record<string, unknown>): Promise<OxelotLike>
}

interface TestWindow extends Window {
  __oxelot?: { Oxelot: OxelotCtor }
}

async function waitForSwActive(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => (await navigator.serviceWorker.ready).active?.state === 'activated',
    undefined,
    { timeout: 10_000 },
  )
}

async function waitForController(page: Page): Promise<void> {
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null, undefined, { timeout: 5000 })
}

/** Post `oxelot-sync` to the active SW and resolve with the flush result. */
async function triggerSwFlush(page: Page): Promise<unknown> {
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
async function seedQueue(page: Page): Promise<void> {
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
async function seedQueueN(page: Page, n: number): Promise<void> {
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

test('1.1 SW activates and registration is idempotent', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

  await page.evaluate(async () => {
    const w = window as TestWindow
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, registerSW: true })
    ;(window as { __r1?: unknown }).__r1 = oxelot
  })

  await waitForSwActive(page)
  // clients.claim() hands control of the already-open page to the SW.
  await waitForController(page)

  const registrations = await page.evaluate(async () => {
    const ox = (window as { __r1?: { registerServiceWorker(): Promise<void> } }).__r1!
    await ox.registerServiceWorker() // idempotent no-op
    const regs = await navigator.serviceWorker.getRegistrations()
    return regs.length
  })
  expect(registrations).toBe(1)
})

test('1.2 tab->SW message relay flushes the shared queue', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
  await resetSyncLog(page)

  const result = await page.evaluate(
    async ({ serverUrl: srv }) => {
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, sync: { serverUrl: srv }, registerSW: true })
      ;(window as { __r2?: unknown }).__r2 = oxelot
      const reg = await navigator.serviceWorker.ready
      await new Promise<void>((resolvePromise) => {
        if (navigator.serviceWorker.controller) resolvePromise()
        else navigator.serviceWorker.addEventListener('controllerchange', () => resolvePromise(), { once: true })
      })
      await oxelot.sync.enqueue({
        id: 'relay-1',
        schemaVersion: 1,
        collection: 'todos',
        op: 'upsert',
        payload: { title: 'alpha' },
        createdAt: Date.now(),
        attempts: 0,
      })
      // Re-send the config (idempotent) so the SW's queue is wired even if the
      // page's fire-and-forget register raced activation.
      const sw = reg.active
      if (!sw) throw new Error('no active SW')
      sw.postMessage({ type: 'oxelot-config', serverUrl: srv })
      const swResult = await new Promise<unknown>((resolvePromise) => {
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
      return swResult
    },
    { serverUrl: SYNC_ENDPOINT },
  )

  expect(result).toMatchObject({ type: 'oxelot-sync-result' })
  const delivered = (result as { delivered?: number }).delivered ?? -1
  expect(delivered).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => (await readSyncLog(page)).length, { timeout: 5000 }).toBe(1)
  const bodies = await readSyncLog(page)
  expect(JSON.parse(bodies[0] as string)).toMatchObject({ id: 'relay-1', collection: 'todos' })
})

test('1.3 SW flushes envelopes seeded while offline after connectivity restore', async ({ page, context }) => {
  await context.grantPermissions(['background-sync'])
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
  await resetSyncLog(page)

  // Page boots WITHOUT a sync config: its own queue is a NoopSync, so only the
  // SW (wired via oxelot-config) can ever deliver.
  await page.evaluate(async () => {
    const w = window as TestWindow
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, registerSW: true })
    ;(window as { __r3?: unknown }).__r3 = oxelot
  })
  await waitForSwActive(page)
  await waitForController(page)

  // Wire the SW's queue. Note: Chromium headless disables the real Background
  // Sync scheduler (registration.sync.register throws "Background Sync is
  // disabled" even with the permission granted), so the `sync` event itself
  // cannot be fired in CI. The sync handler calls getSync().flush(); we drive
  // that identical flush path via the `oxelot-sync` relay message after the
  // offline->online transition. Real-sync-event firing stays on the manual
  // browser matrix (Chapter 8 §8.4).
  await page.evaluate(
    async ({ serverUrl: srv }) => {
      const reg = await navigator.serviceWorker.ready
      reg.active?.postMessage({ type: 'oxelot-config', serverUrl: srv })
    },
    { serverUrl: SYNC_ENDPOINT },
  )

  // Emulate the offline period, then seed the shared queue while offline.
  await context.setOffline(true)
  await seedQueue(page)
  await page.waitForTimeout(500)
  // Nothing may reach the server while offline.
  expect(await readSyncLog(page)).toHaveLength(0)

  // Restore connectivity; the SW drains the queue seeded offline.
  await context.setOffline(false)
  const result = await triggerSwFlush(page)
  expect(result).toMatchObject({ type: 'oxelot-sync-result' })
  expect((result as { delivered?: number }).delivered ?? -1).toBe(2)

  await expect.poll(async () => (await readSyncLog(page)).length, { timeout: 5000 }).toBe(2)
  const bodies = await readSyncLog(page)
  const ids = bodies.map((b) => (JSON.parse(b) as { id?: string }).id)
  expect(ids).toContain('sync-1')
  expect(ids).toContain('sync-2')
})

test('1.4 shared-queue 10k soak: SW drains a 10k-envelope backlog @perf', async ({ page, context }) => {
  test.setTimeout(600_000)
await context.grantPermissions(['background-sync'])
    await page.goto('/')
    await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
    await resetSyncLog(page)

    await page.evaluate(async () => {
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, registerSW: true })
      ;(window as { __r4?: unknown }).__r4 = oxelot
    })
    await waitForSwActive(page)
    await waitForController(page)

    // Wire the SW queue, then seed a 10k-envelope backlog directly into the
    // shared IndexedDB kv (the same `oxelot`/`kv` store both page-side and
    // SW-side read).
    await page.evaluate(
      async ({ serverUrl: srv }) => {
        const reg = await navigator.serviceWorker.ready
        reg.active?.postMessage({ type: 'oxelot-config', serverUrl: srv })
      },
      { serverUrl: SYNC_ENDPOINT },
    )
    await seedQueueN(page, 10_000)
    await page.waitForTimeout(300)

    const result = await triggerSwFlush(page)
    expect(result).toMatchObject({ type: 'oxelot-sync-result' })
    expect((result as { delivered?: number }).delivered ?? -1).toBe(10_000)
    expect((result as { deadLetters?: number }).deadLetters ?? -1).toBe(0)

    // Every envelope reaches the server exactly once.
    await expect.poll(async () => (await readSyncLog(page)).length, { timeout: 300_000 }).toBe(10_000)
    const soaks = await readSyncLog(page)
    const ids = soaks.map((b) => (JSON.parse(b) as { id?: string }).id)
    expect(new Set(ids).size).toBe(10_000)

    // Queue is drained; nothing remains pending.
    const status = await page.evaluate(async () => {
      const ox = (window as { __r4?: { sync: { status(): Promise<{ pending: number; deadLetters: number }> } } }).__r4
      return ox ? ox.sync.status() : { pending: -1, deadLetters: -1 }
    })
    expect(status).toEqual({ pending: 0, deadLetters: 0 })
  })