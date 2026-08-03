import { test, expect } from '@playwright/test'
import type { TestWindow } from './fixtures/oxelot-like'

// G1 (Chapter 2 §2.1, Chapter 8 §8.4): no long tasks > 16ms during the 30s
// heavy workload. Tagged @perf so `npm run test:perf` (and the nightly CI job)
// runs it, keeping PR e2e fast.
test.setTimeout(90_000)

test('@perf G1: no long tasks > 16ms during the 30s workload', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

  const { longTasks, iterations } = await page.evaluate(async () => {
    const w = window as TestWindow
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 2, dbName: 'perf.db' })

    // Seed the perf table.
    await oxelot.db.run('CREATE TABLE IF NOT EXISTS perf (n INTEGER)')

    const samples: Array<{ duration: number; startTime: number }> = []
    let observer: PerformanceObserver | null = null
    if (typeof PerformanceObserver !== 'undefined') {
      observer = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) samples.push({ duration: e.duration, startTime: e.startTime })
      })
      observer.observe({ entryTypes: ['longtask'] })
    }

    const deadline = performance.now() + 30_000
    let i = 0
    while (performance.now() < deadline) {
      await oxelot.storage.set(`perf-kv-${i % 8}`, { n: i })
      await oxelot.storage.get(`perf-kv-${i % 8}`)

      const file = await oxelot.storage.open(`perf-${i % 4}.bin`)
      const buf = new Uint8Array(4096)
      buf.fill(i % 256)
      await file.writeBytes(0, buf)
      await file.sync()
      await file.readBytes(0, 4096)
      await file.close()

      await oxelot.db.run('INSERT INTO perf (n) VALUES (?1)', [i])
      await oxelot.db.query('SELECT COUNT(*) AS c FROM perf')

      await oxelot.pool.request('ping')
      i++
    }

    observer?.disconnect()
    await oxelot.dispose()
    return { longTasks: samples, iterations: i }
  })

  expect(iterations).toBeGreaterThan(0)
  const worst = longTasks.reduce((m, s) => Math.max(m, s.duration), 0)
  const over = longTasks.filter((s) => s.duration > 16)
  expect(over, `long tasks over 16ms: ${JSON.stringify(over)}; worst=${worst.toFixed(1)}ms over ${iterations} iters`).toEqual([])
})
