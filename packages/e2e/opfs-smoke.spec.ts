import { test, expect } from '@playwright/test'
import type { TestWindow } from './fixtures/oxelot-like'

// G2 CI smoke (Chapter 2 §2.1). The full 500MB soak is a manual/@g2-full run
// (not in GitHub Actions, which has CI time limits); this 5MB byte-exact
// round-trip guards regressions in every PR. Named `opfs` so the webkit
// project picks it up too.
test('opfs 5MB soak: write → reload → read byte-identical (G2 CI smoke)', async ({ page }) => {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

  const SIZE = 5 * 1024 * 1024
  const CHUNK = 1 << 20

  // Write in one page load.
  await page.evaluate(
    async ({ size, chunkSize }) => {
      const pb = (offset: number): number => (offset * 131 + (offset >> 8) * 29 + 7) & 0xff
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({ workers: 2, dbName: 'g2.db' })
      const file = await oxelot.storage.open('g2-soak.bin')
      for (let offset = 0; offset < size; offset += chunkSize) {
        const len = Math.min(chunkSize, size - offset)
        const chunk = new Uint8Array(len)
        for (let i = 0; i < len; i++) chunk[i] = pb(offset + i)
        await file.writeBytes(offset, chunk)
      }
      await file.sync()
      await file.close()
      await oxelot.dispose()
    },
    { size: SIZE, chunkSize: CHUNK },
  )

  // Reload, then read and verify byte-identical.
  await page.reload()
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
  const ok = await page.evaluate(
    async ({ size, chunkSize }) => {
      const pb = (offset: number): number => (offset * 131 + (offset >> 8) * 29 + 7) & 0xff
      const w = window as TestWindow
      const oxelot = await w.__oxelot!.Oxelot.init({ workers: 2, dbName: 'g2.db' })
      try {
        const file = await oxelot.storage.open('g2-soak.bin')
        const actualSize = await file.size()
        if (actualSize !== size) return { ok: false, reason: `size ${actualSize} != ${size}` }
        let offset = 0
        while (offset < size) {
          const len = Math.min(chunkSize, size - offset)
          const data = await file.readBytes(offset, len)
          if (data.length !== len) return { ok: false, reason: `short read at ${offset}` }
          for (let i = 0; i < len; i++) {
            if (data[i] !== pb(offset + i)) {
              return { ok: false, reason: `byte mismatch at ${offset + i}` }
            }
          }
          offset += len
        }
        await file.close()
        await oxelot.storage.remove('g2-soak.bin')
        return { ok: true, reason: '' }
      } catch (err) {
        return { ok: false, reason: err instanceof Error ? err.message : String(err) }
      } finally {
        await oxelot.dispose()
      }
    },
    { size: SIZE, chunkSize: CHUNK },
  )

  expect(ok.ok, ok.reason).toBe(true)
})
