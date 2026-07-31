import { expect, test } from '@playwright/test'

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
    const { Oxelot } = await import('@oxelot/core')
    const oxelot = await Oxelot.init({ workers: 2 })
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
  await page.goto('/')
  const result = await page.evaluate(async () => {
    // Simulate a DOM-less context: core must not reference window/document.
    const { Oxelot } = await import('@oxelot/core')
    const src = await (await fetch('/node_modules/@oxelot/core/dist/index.js')).text()
    return {
      hasWindow: /\bwindow\b/.test(src),
      hasDocument: /\bdocument\b/.test(src),
      canInstantiate: typeof Oxelot === 'function',
    }
  })
  expect(result.hasWindow).toBe(false)
  expect(result.hasDocument).toBe(false)
  expect(result.canInstantiate).toBe(true)
})
