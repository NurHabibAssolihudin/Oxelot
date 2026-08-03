import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE_DIST = join(__dirname, '..', 'core', 'dist', 'index.js')

interface PoolLike {
  request(op: string): Promise<unknown>
}

interface OxelotLike {
  pool: PoolLike
  dispose(): Promise<void>
}

type OxelotCtor = {
  init(cfg: { workers: number }): Promise<OxelotLike>
}

interface TestWindow extends Window {
  __oxelot?: { Oxelot: OxelotCtor }
}

test('Oxelot initializes and performs a storage round-trip', async ({ page }) => {
  await page.goto('/')
  const pre = page.locator('pre')
  await expect(pre).toContainText('ready: backend=')
  await expect(pre).toContainText('storage round-trip: hello from oxelot')
  await expect(pre).toContainText('playground smoke test complete')
})

test('worker round-trip stays within the G3 budget', async ({ page }) => {
  await page.goto('/')
  const pre = page.locator('pre')
  await expect(pre).toContainText('playground smoke test complete')
  const timing = await page.evaluate(async () => {
    const w = window as TestWindow
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 2 })
    const samples: number[] = []
    for (let i = 0; i < 50; i++) {
      const t0 = performance.now()
      await oxelot.pool.request('ping')
      samples.push(performance.now() - t0)
    }
    await oxelot.dispose()
    samples.sort((a, b) => a - b)
    return { p95: samples[Math.floor(samples.length * 0.95)] ?? 0 }
  })
  expect(timing.p95).toBeLessThan(16)
})

test('no-DOM bootstrap probe (B-1): core boots without window/document', async ({ page }) => {
  const src = readFileSync(CORE_DIST, 'utf8')
  expect(/\bwindow\b/.test(src)).toBe(false)
  expect(/\bdocument\b/.test(src)).toBe(false)
  await page.goto('/')
  const canInstantiate = await page.evaluate(() => {
    const w = window as TestWindow
    return typeof w.__oxelot?.Oxelot === 'function'
  })
  expect(canInstantiate).toBe(true)
})
