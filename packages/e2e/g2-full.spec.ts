import { test, expect } from '@playwright/test'
import type { TestWindow } from './fixtures/oxelot-like'

// G2 full soak (Chapter 2 §2.1): 500MB OPFS dataset, write → reload → read
// byte-identical. NOT part of the default suite (GitHub Actions CI has time
// limits). Run manually:
//   npx playwright test --project=chromium --grep "@g2-full"
test.setTimeout(600_000)

test('@g2-full OPFS 500MB soak: write → reload → read byte-identical', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

  const SIZE = 500 * 1024 * 1024
  const CHUNK = 4 * 1024 * 1024

  const writeMs = await page.evaluate(
    async ({ size, chunkSize }) => {
      const pb = (offset: number): number => (offset * 131 + (offset >> 8) * 29 + 7) & 0xff
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({ workers: 4, dbName: 'g2full.db' })
      const file = await oxelot.storage.open('g2-500mb.bin')
      const t0 = performance.now()
      for (let offset = 0; offset < size; offset += chunkSize) {
        const len = Math.min(chunkSize, size - offset)
        const chunk = new Uint8Array(len)
        for (let i = 0; i < len; i++) chunk[i] = pb(offset + i)
        await file.writeBytes(offset, chunk)
      }
      await file.sync()
      await file.close()
      await oxelot.dispose()
      return performance.now() - t0
    },
    { size: SIZE, chunkSize: CHUNK },
  )

  await page.reload()
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

  const verifyMs = await page.evaluate(
    async ({ size, chunkSize }) => {
      const pb = (offset: number): number => (offset * 131 + (offset >> 8) * 29 + 7) & 0xff
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({ workers: 4, dbName: 'g2full.db' })
      const t0 = performance.now()
      const file = await oxelot.storage.open('g2-500mb.bin')
      const actualSize = await file.size()
      if (actualSize !== size) throw new Error(`size ${actualSize} != ${size}`)
      let offset = 0
      while (offset < size) {
        const len = Math.min(chunkSize, size - offset)
        const data = await file.readBytes(offset, len)
        if (data.length !== len) throw new Error(`short read at ${offset}`)
        for (let i = 0; i < len; i++) {
          if (data[i] !== pb(offset + i)) throw new Error(`byte mismatch at ${offset + i}`)
        }
        offset += len
      }
      await file.close()
      await oxelot.storage.remove('g2-500mb.bin')
      await oxelot.dispose()
      return performance.now() - t0
    },
    { size: SIZE, chunkSize: CHUNK },
  )

  expect(verifyMs).toBeGreaterThan(0)
  console.log(`G2 500MB: write=${(writeMs / 1000).toFixed(1)}s verify=${(verifyMs / 1000).toFixed(1)}s`)
})
