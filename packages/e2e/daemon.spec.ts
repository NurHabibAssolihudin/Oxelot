import { expect, test } from '@playwright/test'
import { startDaemonEchoServer } from './daemon-server'
import type { DaemonEchoServer } from './daemon-server'
import type { TestWindow } from './sync-helpers'

interface DaemonBridgeLike {
  connect(): Promise<void>
  has(cap: string): boolean
  request<T>(cap: string, data?: unknown): Promise<T>
  fileGet<T>(key: string): Promise<T | null>
  fileSet<T>(key: string, value: T): Promise<void>
  grant(cap: string): void
}

interface DaemonOxelotLike {
  daemon: DaemonBridgeLike | null
}

test.describe('M3.2 daemon bridge (Playwright, fake daemon on ws://127.0.0.1)', () => {
  let server: DaemonEchoServer

  test.beforeAll(async () => {
    server = await startDaemonEchoServer()
  })

  test.afterAll(async () => {
    await server.close()
  })

  test('handshake + capability RPC round-trips over a real WebSocket', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

    const result = await page.evaluate(
      async ({ url }) => {
        const w = window as TestWindow
        const ox = (await w.__oxelot!.Oxelot.init({ workers: 1, daemon: { url } })) as DaemonOxelotLike
        const daemon = ox.daemon
        if (!daemon) throw new Error('daemon bridge not created')
        await daemon.connect()
        return {
          hasEcho: daemon.has('echo'),
          echo: await daemon.request<{ echo: unknown }>('echo', { msg: 'hi' }),
          stats: await daemon.request<{ cpu: number; mem: number }>('sys:stats'),
        }
      },
      { url: server.url },
    )

    expect(result.hasEcho).toBe(true)
    expect(result.echo).toEqual({ echo: { msg: 'hi' } })
    expect(result.stats).toEqual({ cpu: 12, mem: 34 })
  })

  test('file: storage handoff (M3.2) through the daemon', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

    const result = await page.evaluate(
      async ({ url }) => {
        const w = window as TestWindow
        const ox = (await w.__oxelot!.Oxelot.init({ workers: 1, daemon: { url } })) as DaemonOxelotLike
        const daemon = ox.daemon!
        await daemon.connect()
        await daemon.fileSet('demo-key', { hello: 'world' })
        const got = await daemon.fileGet<{ hello: string }>('demo-key')
        const missing = await daemon.fileGet('never-stored')
        return { got, missing }
      },
      { url: server.url },
    )

    expect(result.got).toEqual({ hello: 'world' })
    expect(result.missing).toBeNull()
  })

  test('daemon absent ⇒ additive no-op (no url configured)', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

    const hasDaemon = await page.evaluate(async () => {
      const w = window as TestWindow
      const ox = (await w.__oxelot!.Oxelot.init({ workers: 1 })) as DaemonOxelotLike
      return ox.daemon !== null
    })
    expect(hasDaemon).toBe(false)
  })

  test('capability gating: unadvertised ⇒ ERR_DAEMON_UNSUPPORTED; advertised-but-unimplemented ⇒ ERR_DAEMON_NOT_FOUND', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

    const codes = await page.evaluate(
      async ({ url }) => {
        const w = window as TestWindow
        const ox = (await w.__oxelot!.Oxelot.init({ workers: 1, daemon: { url } })) as DaemonOxelotLike
        const daemon = ox.daemon!
        await daemon.connect()
        const grab = async (cap: string): Promise<string> => {
          try {
            await daemon.request(cap)
            return 'NO_REJECTION'
          } catch (err) {
            return (err as { code?: string }).code ?? 'NO_CODE'
          }
        }
        return {
          unadvertised: await grab('no.such.cap'),
          unimplemented: await grab('boom'),
        }
      },
      { url: server.url },
    )
    expect(codes.unadvertised).toBe('ERR_DAEMON_UNSUPPORTED')
    expect(codes.unimplemented).toBe('ERR_DAEMON_NOT_FOUND')
  })

  test('M3.3 permission gate: grant within a user gesture unlocks a permission:true cap', async ({ page }) => {
    await page.goto('/')
    await page.waitForFunction(() => typeof (window as TestWindow).__oxelot?.Oxelot === 'function')

    await page.evaluate(
      async ({ url }) => {
        const w = window as TestWindow
        const ox = (await w.__oxelot!.Oxelot.init({ workers: 1, daemon: { url } })) as DaemonOxelotLike
        ;(window as { __oxM?: DaemonOxelotLike }).__oxM = ox
        await ox.daemon!.connect()
        const btn = document.createElement('button')
        btn.id = 'grant-btn'
        document.body.appendChild(btn)
      },
      { url: server.url },
    )

    // Without a grant, permission:true caps are rejected client-side.
    const before = await page.evaluate(async () => {
      const ox = (window as { __oxM?: DaemonOxelotLike }).__oxM!
      try {
        await ox.daemon!.request('serial:read', { handle: 'h', size: 5 })
        return 'NO_REJECTION'
      } catch (err) {
        return (err as { code?: string }).code ?? 'NO_CODE'
      }
    })
    expect(before).toBe('ERR_PERMISSION_DENIED')

    // permissionless caps need no grant.
    const list = await page.evaluate(async () => {
      const ox = (window as { __oxM?: DaemonOxelotLike }).__oxM!
      const ports = await ox.daemon!.request<{ path: string }[]>('serial:list')
      return ports
    })
    expect(list).toEqual([{ path: '/dev/ttyUSB0', vendorId: '1a86', productId: '7523' }])

    // Grant inside a real click (transient user activation), then request.
    await page.evaluate(() => {
      const btn = document.getElementById('grant-btn')!
      btn.onclick = async (): Promise<void> => {
        const ox = (window as { __oxM?: DaemonOxelotLike }).__oxM!
        try {
          ox.daemon!.grant('serial:read')
          const res = await ox.daemon!.request<{ bytes: string }>('serial:read', { handle: 'h', size: 5 })
          ;(window as { __grantResult?: unknown }).__grantResult = { ok: true, bytes: res.bytes }
        } catch (err) {
          ;(window as { __grantResult?: unknown }).__grantResult = { ok: false, code: (err as { code?: string }).code }
        }
      }
    })
    await page.click('#grant-btn')
    await page.waitForFunction(() => (window as { __grantResult?: unknown }).__grantResult !== undefined)
    const after = await page.evaluate(() => (window as { __grantResult?: unknown }).__grantResult)
    expect(after).toMatchObject({ ok: true, bytes: 'aGVsbG8=' })
  })
})