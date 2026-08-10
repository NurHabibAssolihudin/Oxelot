import { expect, test } from '@playwright/test'
import { resetSyncLog, readSyncLog, triggerSwFlush, waitForController, waitForSwActive, SYNC_ENDPOINT } from './sync-helpers'
import type { TestWindow } from './sync-helpers'

interface OxelotLike {
  sync: { enqueue(m: Record<string, unknown>): Promise<void> }
  syncCapabilities(): Promise<{ backgroundSync: boolean; periodicSync: boolean }>
}

async function bootWithPeriodic(page: import('@playwright/test').Page, periodicSync: boolean): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
  await page.evaluate(
    async ({ serverUrl, enablePeriodic }) => {
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({
        workers: 1,
        sync: { serverUrl },
        registerSW: true,
        features: { periodicSync: enablePeriodic },
      })
      ;(window as { __p?: OxelotLike }).__p = oxelot as OxelotLike
    },
    { serverUrl: SYNC_ENDPOINT, enablePeriodic: periodicSync },
  )
  await waitForSwActive(page)
  await waitForController(page)
}

test('4.1 features.periodicSync: capability surface matches the environment truth table; SW relay unaffected', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Background Sync capability checks are Chromium-only')
  await resetSyncLog(page)
  await bootWithPeriodic(page, true)

  // slice 4.2: `syncCapabilities()` must mirror what the engine actually
  // exposes on the registration (`sync` ⇔ one-shot, `periodicSync` ⇔ periodic).
  const caps = await page.evaluate(async () => {
    const ox = (window as { __p?: OxelotLike }).__p!
    return ox.syncCapabilities()
  })
  const raw = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.ready
    return { backgroundSync: 'sync' in reg, periodicSync: 'periodicSync' in reg }
  })
  expect(caps).toEqual(raw)
  expect(typeof caps.backgroundSync).toBe('boolean')
  expect(typeof caps.periodicSync).toBe('boolean')

  // slice 4.1: with the feature on, registration must not throw — boot resolved,
  // and the same SW that (attempted to) register periodic sync still drains the
  // shared queue via the oxelot-sync relay.
  await page.evaluate(async () => {
    const ox = (window as { __p?: OxelotLike }).__p!
    await ox.sync.enqueue({
      id: 'periodic-1',
      schemaVersion: 1,
      collection: 'todos',
      op: 'upsert',
      payload: { title: 'periodic' },
      createdAt: Date.now(),
      attempts: 0,
    })
  })
  const result = await triggerSwFlush(page)
  expect(result).toMatchObject({ type: 'oxelot-sync-result' })
  expect((result as { delivered?: number }).delivered ?? -1).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => (await readSyncLog(page)).length, { timeout: 5000 }).toBe(1)
})

test('4.2 features.periodicSync off (default): graceful no-op fallback, SW relay still functional', async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== 'chromium', 'Background Sync capability checks are Chromium-only')
  await resetSyncLog(page)
  await bootWithPeriodic(page, false)

  const caps = await page.evaluate(async () => {
    const ox = (window as { __p?: OxelotLike }).__p!
    return ox.syncCapabilities()
  })
  // Capability surfacing is independent of the feature flag: it reports the
  // environment truth table, while registration itself stays disabled.
  expect(typeof caps.backgroundSync).toBe('boolean')
  expect(typeof caps.periodicSync).toBe('boolean')

  await page.evaluate(async () => {
    const ox = (window as { __p?: OxelotLike }).__p!
    await ox.sync.enqueue({
      id: 'periodic-off-1',
      schemaVersion: 1,
      collection: 'todos',
      op: 'upsert',
      payload: { title: 'periodic-off' },
      createdAt: Date.now(),
      attempts: 0,
    })
  })
  // With the feature off no periodicSync registration is attempted, but the
  // shared SW queue is untouched by that decision: the relay flush drains it.
  const result = await triggerSwFlush(page)
  expect(result).toMatchObject({ type: 'oxelot-sync-result' })
  expect((result as { delivered?: number }).delivered ?? -1).toBeGreaterThanOrEqual(1)
  await expect.poll(async () => (await readSyncLog(page)).length, { timeout: 5000 }).toBe(1)
})