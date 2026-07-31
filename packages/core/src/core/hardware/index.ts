import { oxError } from '../../errors'

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

  async acquire(cap: HardwareCapability): Promise<void> {
    if (!this.isAvailable(cap)) {
      throw oxError('ERR_HW_UNSUPPORTED', `hardware capability "${cap}" is not available`)
    }
    // Native prompts (WebUSB requestDevice, Web NFC scan, Wake Lock) are
    // triggered by the consumer with the actual device APIs; acquire() here
    // only asserts availability so callers can branch. Actual invocation
    // remains consumer-driven.
  }

  async release(cap: HardwareCapability): Promise<void> {
    void cap
  }
}

export { UNSET }
