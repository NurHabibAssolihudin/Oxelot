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

async function wireSwConfig(page: Page): Promise<void> {
  await page.evaluate(
    async ({ serverUrl: srv }) => {
      const reg = await navigator.serviceWorker.ready
      reg.active?.postMessage({ type: 'oxelot-config', serverUrl: srv })
    },
    { serverUrl: SYNC_ENDPOINT },
  )
}

/**
 * G4 soak (Chapter 2 §2.3, M2 exit criteria): 100k envelopes accumulate while
 * the device is offline; on connectivity restore the SW drains the shared queue.
 * The gate is ≥99% delivered exactly-once within the 24h soak window. Headless
 * Chromium disables the real Background Sync scheduler, so the drain is driven
 * through the same flush path the `sync` event uses (see slice 1.3 caveat); the
 * full 24h timing stays on the manual matrix (Chapter 8 §8.4).
 */
test('G4 soak 100k: SW drains a 100k-envelope offline backlog on restore @perf', async ({ page, context }) => {
  test.setTimeout(1_800_000)
  await context.grantPermissions(['background-sync'])
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
  await resetSyncLog(page)

  await page.evaluate(async () => {
    const w = window as TestWindow
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, registerSW: true })
    ;(window as { __g4?: unknown }).__g4 = oxelot
  })
  await waitForSwActive(page)
  await waitForController(page)
  await wireSwConfig(page)

  const n = 100_000
  const startedAt = Date.now()

  // Offline accumulation: seed the shared queue while the device is
  // unreachable; nothing may reach the server yet.
  await context.setOffline(true)
  await seedQueueN(page, n)
  await page.waitForTimeout(500)
  expect(await readSyncLog(page)).toHaveLength(0)

  // Connectivity restore: the SW drains the whole backlog.
  await context.setOffline(false)
  const result = await triggerSwFlush(page)
  const drainMs = Date.now() - startedAt

  expect(result).toMatchObject({ type: 'oxelot-sync-result' })
  const delivered = (result as { delivered?: number }).delivered ?? -1
  const dead = (result as { deadLetters?: number }).deadLetters ?? -1
  // G4 gate: ≥99% delivered within the soak window, exactly-once, no dead letters.
  expect(delivered).toBeGreaterThanOrEqual(Math.floor(n * 0.99))
  expect(dead).toBe(0)

  // Every delivered envelope reached the server exactly once (no duplicates).
  const bodies = await readSyncLog(page)
  expect(bodies.length).toBeGreaterThanOrEqual(Math.floor(n * 0.99))
  const ids = bodies.map((b) => (JSON.parse(b) as { id?: string }).id)
  expect(new Set(ids).size).toBe(bodies.length)

  // Queue is drained; nothing remains pending.
  const status = await page.evaluate(async () => {
    const ox = (window as { __g4?: { sync: { status(): Promise<{ pending: number; deadLetters: number }> } } }).__g4
    return ox ? ox.sync.status() : { pending: -1, deadLetters: -1 }
  })
  expect(status).toEqual({ pending: 0, deadLetters: 0 })

  test.info().annotations.push({
    type: 'issue',
    description: `G4: ${delivered}/${n} delivered exactly-once in ${(drainMs / 1000).toFixed(1)}s (well within the 24h soak window)`,
  })
})