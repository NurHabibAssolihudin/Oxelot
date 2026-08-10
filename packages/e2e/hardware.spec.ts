import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import type { TestWindow } from './sync-helpers'

type Caps = Record<string, boolean>

interface OxelotInstance {
  hardware: {
    capabilities(): Promise<Caps>
    acquire(cap: string): Promise<void>
  }
}

type TestWin = TestWindow & { __h?: OxelotInstance }

const EXPECTED: Record<string, Caps> = {
  chromium: {
    nfc: false,
    usb: true,
    bluetooth: true,
    wakeLock: true,
    fileSystemAccess: true,
    vibration: true,
    daemon: false,
  },
  webkit: {
    nfc: false,
    usb: false,
    bluetooth: false,
    wakeLock: true,
    fileSystemAccess: false,
    vibration: false,
    daemon: false,
  },
  firefox: {
    nfc: false,
    usb: false,
    bluetooth: false,
    wakeLock: true,
    fileSystemAccess: false,
    vibration: false,
    daemon: false,
  },
}

async function bootOxelot(page: Page): Promise<void> {
  await page.goto('/')
  await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')
  await page.evaluate(async () => {
    const w = window as TestWin
    const oxelot = await w.__oxelot!.Oxelot.init({ workers: 1 })
    w.__h = oxelot as unknown as OxelotInstance
  })
}

test('5.2 capabilities() matches the §5.3.1 truth table for this engine', async ({ page, browserName }) => {
  await bootOxelot(page)
  const caps = await page.evaluate(async () => (window as TestWin).__h!.hardware.capabilities())
  const expected = EXPECTED[browserName]
  expect(expected, `no expected truth table for browser "${browserName}"`).toBeDefined()
  expect(caps).toEqual(expected)
})

test('5.2 acquire() on an unavailable capability rejects ERR_HW_UNSUPPORTED', async ({ page }) => {
  await bootOxelot(page)
  const unsupported = await page.evaluate(async () => {
    const w = window as TestWin
    const caps = await w.__h!.hardware.capabilities()
    return Object.keys(caps).find((k) => caps[k] === false) ?? null
  })
  expect(unsupported, 'every engine has at least one unavailable capability').not.toBeNull()

  const code = await page.evaluate(async (cap) => {
    const w = window as TestWin
    try {
      await w.__h!.hardware.acquire(cap)
      return 'no-error'
    } catch (e) {
      return (e as { code?: string }).code ?? 'unknown'
    }
  }, unsupported as string)
  expect(code).toBe('ERR_HW_UNSUPPORTED')
})