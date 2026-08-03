import { expect, test } from '@playwright/test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CORE_DIST = join(__dirname, '..', 'core', 'dist', 'index.js')

interface PoolLike {
  request(op: string): Promise<unknown>
}

interface StorageFacadeLike {
  readonly backend: string
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  remove(name: string): Promise<void>
  open(name: string, mode?: string): Promise<{
    size(): Promise<number>
    readBytes(offset: number, length: number): Promise<Uint8Array>
    writeBytes(offset: number, data: Uint8Array): Promise<void>
    truncate(size: number): Promise<void>
    sync(): Promise<void>
    close(): Promise<void>
  }>
  entries(): Promise<string[]>
}

interface OxelotLike {
  pool: PoolLike
  storage: StorageFacadeLike
  db: {
    run(sql: string, params?: unknown[]): Promise<void>
    query<T>(sql: string, params?: unknown[]): Promise<T[]>
    checkpoint(): Promise<void>
  }
  on(cb: (ev: { type: string; key?: string; sourceTab?: string }) => void): () => void
  dispose(): Promise<void>
}

type OxelotCtor = {
  init(cfg: { workers: number; dbName?: string }): Promise<OxelotLike>
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

test('React hooks (M1.6): useOxelotStorage/useOxelotDB drive the playground UI', async ({ page }) => {
  await page.goto('/')
  const pre = page.locator('pre')
  await expect(pre).toContainText('ready: backend=')
  await expect(pre).toContainText('storage round-trip: hello from oxelot')
  await expect(pre).toContainText('file size: 4')
  await expect(pre).toContainText('db round-trip: hello db')
  await expect(pre).toContainText('db rows persisted: 1')
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

test('SQLite WASM: db round-trip and persistence across reload (M1.4)', async ({ page }) => {
  await page.goto('/')
  const pre = page.locator('pre')
  await expect(pre).toContainText('db round-trip: hello db')
  await expect(pre).toContainText('playground smoke test complete')
  const firstCount = await page
    .locator('pre')
    .textContent()
    .then((t) => Number((t ?? '').match(/db rows persisted: (\d+)/)?.[1] ?? 0))
  expect(firstCount).toBeGreaterThanOrEqual(1)

  await page.reload()
  await expect(pre).toContainText('playground smoke test complete')
  await expect(pre).toContainText('db round-trip: hello db')
  const secondCount = await page
    .locator('pre')
    .textContent()
    .then((t) => Number((t ?? '').match(/db rows persisted: (\d+)/)?.[1] ?? -1))
  expect(secondCount).toBe(firstCount)
})

test('WASM ready: first db op (load + init) completes within the G7 budget', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

  // The .wasm asset must be built and served; the first db.* op triggers the
  // cold load (fetch + compile + instantiate + seed). G7 targets mid-tier
  // Android (manual matrix); on desktop Chromium CI we assert a generous bound.
  const ms = await page.evaluate(async () => {
    const w = window as TestWindow
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, dbName: 'g7.db' })
    const t0 = performance.now()
    await oxelot.db.run('CREATE TABLE IF NOT EXISTS g7 (n INTEGER)')
    const elapsed = performance.now() - t0
    await oxelot.dispose()
    return elapsed
  })

  expect(ms).toBeGreaterThan(0)
  // Desktop Chromium bound. Android mid-tier is asserted in the manual matrix
  // (Chapter 8 §8.4.4); this guards gross regressions (e.g., missing asset).
  expect(ms, `first db op took ${ms.toFixed(1)}ms`).toBeLessThan(5_000)
})

test('cross-tab storage-change propagates to a sibling tab within 100ms (M1.5)', async ({ context }) => {
  const pageA = await context.newPage()
  const pageB = await context.newPage()
  await pageA.goto('/')
  await pageB.goto('/')

  // Both tabs expose the Oxelot constructor (playground bootstraps it eagerly).
  for (const page of [pageA, pageB]) {
    await page.waitForFunction(
      () => typeof (window as TestWindow).__oxelot?.Oxelot === 'function',
      undefined,
      { timeout: 10000 },
    )
  }

  // Tab B subscribes and records storage-change events on window.__m15.
  await pageB.evaluate(async () => {
    const w = window as TestWindow & {
      __m15?: Array<{ key: string; sourceTab: string; at: number }>
    }
    w.__m15 = []
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, dbName: 'm15.db' })
    oxelot.on((ev) => {
      if (ev.type === 'storage-change' && ev.key && ev.sourceTab) {
        // Date.now() is wall-clock and comparable across tabs (unlike
        // performance.now(), which is per-renderer in Chromium).
        w.__m15!.push({ key: ev.key, sourceTab: ev.sourceTab, at: Date.now() })
      }
    })
    ;(window as { __m15Oxelot?: unknown }).__m15Oxelot = oxelot
  })

  // Tab A writes after ready; record the wall-clock write timestamp.
  const writeAt = await pageA.evaluate(async () => {
    const w = window as TestWindow
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1, dbName: 'm15.db' })
    const t0 = Date.now()
    await oxelot.storage.set('m15-key', { n: 1 })
    return t0
  })

  await pageB.waitForFunction(
    (t0) => (window as { __m15?: Array<{ at: number }> }).__m15?.some((m) => m.at >= t0) ?? false,
    writeAt,
    { timeout: 2000 },
  )

  const latency = await pageB.evaluate(() => {
    const m = (window as { __m15?: Array<{ at: number }> }).__m15 ?? []
    return m[m.length - 1]?.at ?? -1
  })
  expect(latency - writeAt).toBeGreaterThanOrEqual(0)
  expect(latency - writeAt).toBeLessThan(100)

  await pageB.evaluate(() => (window as { __m15Oxelot?: { dispose(): Promise<void> } }).__m15Oxelot?.dispose())
})
