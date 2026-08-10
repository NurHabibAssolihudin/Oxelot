import { OxelotError, oxError } from '../../errors'
import type { HardwareCapability } from './index'

/**
 * Narrow shims over the native Fugu APIs so `acquireNative` is unit-testable
 * with plain fakes (no DOM globals required in Node). Props are required-but-
 * `undefined`-able (project uses `exactOptionalPropertyTypes`).
 */
export interface HardwareEnvNav {
  usb: { requestDevice(options: unknown): Promise<unknown> } | undefined
  bluetooth: { requestDevice(options: unknown): Promise<unknown> } | undefined
  wakeLock: { request(name: string): Promise<WakeLockSentinelLike | undefined> } | undefined
  vibrate: ((pattern: number | number[]) => boolean) | undefined
}
export interface WakeLockSentinelLike {
  release(): Promise<void>
}
export interface HardwareEnvWin {
  NDEFReader: (new () => { scan(options?: unknown): Promise<void> }) | undefined
  showOpenFilePicker: ((options?: unknown) => Promise<unknown>) | undefined
}
export interface HardwareEnv {
  nav: HardwareEnvNav
  win: HardwareEnvWin
}

export interface AcquiredHardware {
  /** Managed handle released by `bridge.release(cap)` (wakeLock). Absent for unmanaged caps. */
  release?: () => Promise<void>
}

/**
 * Map a native prompt failure onto the Oxelot hardware error codes (§5.3.3):
 * - `SecurityError`/`InvalidStateError`/gesture hint ⇒ `ERR_HW_GESTURE_REQUIRED`
 * - user cancellation/denial (`NotFoundError`,`AbortError`,`NotAllowedError`) ⇒ `ERR_HW_DENIED`
 * - anything else ⇒ `ERR_UNKNOWN`
 */
export function toHardwareError(cap: HardwareCapability, err: unknown): OxelotError {
  const name = typeof err === 'object' && err !== null ? (err as { name?: unknown }).name : undefined
  const message = err instanceof Error ? err.message : String(err)
  if (name === 'SecurityError' || name === 'InvalidStateError' || /user gesture/i.test(message)) {
    return oxError('ERR_HW_GESTURE_REQUIRED', `hardware "${cap}" requires a user gesture (${message})`, err)
  }
  if (name === 'NotFoundError' || name === 'AbortError' || name === 'NotAllowedError') {
    return oxError('ERR_HW_DENIED', `hardware "${cap}" was denied (${message})`, err)
  }
  return oxError('ERR_UNKNOWN', `hardware "${cap}" acquisition failed: ${message}`, err)
}

/**
 * Invoke the capability's native prompt (§5.3.3). Assumes `cap` availability was
 * already asserted via `isAvailable`. Rejects with mapped OxelotError codes.
 */
export async function acquireNative(cap: HardwareCapability, env: HardwareEnv): Promise<AcquiredHardware> {
  try {
    switch (cap) {
      case 'usb': {
        await env.nav.usb?.requestDevice({ filters: [] })
        return {}
      }
      case 'bluetooth': {
        await env.nav.bluetooth?.requestDevice({ acceptAllDevices: true })
        return {}
      }
      case 'nfc': {
        const Reader = env.win.NDEFReader
        if (!Reader) throw new Error('NDEFReader missing')
        await new Reader().scan()
        return {}
      }
      case 'wakeLock': {
        const s = await env.nav.wakeLock?.request('screen')
        return { release: async () => { await s?.release() } }
      }
      case 'fileSystemAccess': {
        await env.win.showOpenFilePicker?.()
        return {}
      }
      case 'vibration': {
        env.nav.vibrate?.(10)
        return {}
      }
      default:
        throw oxError('ERR_HW_UNSUPPORTED', `hardware capability "${cap}" has no native acquisition (M2.5)`)
    }
  } catch (err) {
    if (err instanceof OxelotError) throw err
    throw toHardwareError(cap, err)
  }
}