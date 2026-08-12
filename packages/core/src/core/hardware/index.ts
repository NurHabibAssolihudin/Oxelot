import { oxError } from '../../errors'
import { acquireNative } from './native'
import type { HardwareEnv } from './native'

export type HardwareCapability =
  | 'nfc'
  | 'usb'
  | 'bluetooth'
  | 'wakeLock'
  | 'fileSystemAccess'
  | 'vibration'
  | 'daemon'

export interface HardwareCapabilities {
  nfc: boolean
  usb: boolean
  bluetooth: boolean
  wakeLock: boolean
  fileSystemAccess: boolean
  vibration: boolean
  daemon: boolean
}

export interface HardwareBridge {
  capabilities(): Promise<HardwareCapabilities>
  isAvailable(cap: HardwareCapability): boolean
  acquire(cap: HardwareCapability): Promise<void>
  release(cap: HardwareCapability): Promise<void>
  /** Internal readiness reporter (M3.3): surfaces the daemon bridge as the `daemon` capability when `ready`. */
  setDaemonReady(ready: boolean): void
}

const UNSET: HardwareCapabilities = {
  nfc: false,
  usb: false,
  bluetooth: false,
  wakeLock: false,
  fileSystemAccess: false,
  vibration: false,
  daemon: false,
}

export class PlatformHardwareBridge implements HardwareBridge {
  private detected: HardwareCapabilities | null = null
  private readonly releaseHandles = new Map<HardwareCapability, () => Promise<void>>()

  private env(): HardwareEnv {
    const nav = navigator as Navigator & {
      usb?: unknown
      bluetooth?: unknown
      wakeLock?: unknown
      vibrate?: (pattern: number | number[]) => boolean
    }
    const win = globalThis as typeof globalThis & {
      NDEFReader?: new () => { scan(options?: unknown): Promise<void> }
      showOpenFilePicker?: (options?: unknown) => Promise<unknown>
    }
    return {
      nav: {
        usb: nav.usb as { requestDevice(options: unknown): Promise<unknown> } | undefined,
        bluetooth: nav.bluetooth as { requestDevice(options: unknown): Promise<unknown> } | undefined,
        wakeLock: nav.wakeLock as { request(name: string): Promise<{ release(): Promise<void> } | undefined> } | undefined,
        vibrate: (pattern) => nav.vibrate(pattern),
      },
      win: {
        NDEFReader: win.NDEFReader,
        showOpenFilePicker: win.showOpenFilePicker,
      },
    }
  }

  async capabilities(): Promise<HardwareCapabilities> {
    if (this.detected) return this.detected
    const globalScope = globalThis as typeof globalThis & {
      NDEFReader?: unknown
      USB?: unknown
    }
    const nav = navigator as Navigator & {
      usb?: unknown
      bluetooth?: unknown
      wakeLock?: unknown
      vibrate?: (pattern: number | number[]) => boolean
      storage?: unknown
    }
    const windowScope = globalThis as typeof globalThis & {
      showOpenFilePicker?: unknown
    }
    this.detected = {
      nfc: typeof globalScope.NDEFReader !== 'undefined',
      usb: typeof nav.usb !== 'undefined',
      bluetooth: typeof nav.bluetooth !== 'undefined',
      wakeLock: typeof nav.wakeLock !== 'undefined',
      fileSystemAccess: typeof windowScope.showOpenFilePicker !== 'undefined',
      vibration: typeof nav.vibrate === 'function',
      daemon: false,
    }
    return this.detected
  }

  isAvailable(cap: HardwareCapability): boolean {
    return this.detected?.[cap] ?? false
  }

  /** Report the daemon bridge's readiness as the `daemon` capability (§5.4.4/§5.5.2). */
  setDaemonReady(ready: boolean): void {
    if (!this.detected) this.detected = { ...UNSET }
    this.detected.daemon = ready
  }

  async acquire(cap: HardwareCapability): Promise<void> {
    if (!this.isAvailable(cap)) {
      throw oxError('ERR_HW_UNSUPPORTED', `hardware capability "${cap}" is not available`)
    }
    // Map onto the native gesture-gated prompt (§5.3.3): WebUSB/Bluetooth
    // requestDevice, NDEFReader.scan (NFC), Wake Lock request, File System
    // Access picker, Vibration. Rejections map to ERR_HW_GESTURE_REQUIRED /
    // ERR_HW_DENIED via toHardwareError.
    const handle = await acquireNative(cap, this.env())
    if (handle.release) this.releaseHandles.set(cap, handle.release)
  }

  async release(cap: HardwareCapability): Promise<void> {
    const release = this.releaseHandles.get(cap)
    if (release) {
      this.releaseHandles.delete(cap)
      await release()
    }
  }
}

export { UNSET }
