import { describe, expect, it } from 'vitest'
import { PlatformHardwareBridge } from '../src/core/hardware'
import { acquireNative, toHardwareError } from '../src/core/hardware/native'
import type { HardwareEnv } from '../src/core/hardware/native'
import { OxelotError } from '../src/errors'

function domError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name })
}

function emptyEnv(): HardwareEnv {
  return {
    nav: { usb: undefined, bluetooth: undefined, wakeLock: undefined, vibrate: undefined },
    win: { NDEFReader: undefined, showOpenFilePicker: undefined },
  }
}

function envWith(nav: Partial<NonNullable<HardwareEnv['nav']>>, win: Partial<NonNullable<HardwareEnv['win']>> = {}): HardwareEnv {
  return {
    nav: { usb: undefined, bluetooth: undefined, wakeLock: undefined, vibrate: undefined, ...nav },
    win: { NDEFReader: undefined, showOpenFilePicker: undefined, ...win },
  }
}

describe('toHardwareError (M2.5 §5.3.3 mapping)', () => {
  it('maps SecurityError + gesture hint to ERR_HW_GESTURE_REQUIRED', () => {
    const e = toHardwareError('usb', domError('SecurityError', 'Must be handling a user gesture to show a permission request.'))
    expect(e).toBeInstanceOf(OxelotError)
    expect(e.code).toBe('ERR_HW_GESTURE_REQUIRED')
  })
  it('maps InvalidStateError to ERR_HW_GESTURE_REQUIRED', () => {
    expect(toHardwareError('bluetooth', domError('InvalidStateError', 'x')).code).toBe('ERR_HW_GESTURE_REQUIRED')
  })
  it('maps user cancellation (NotFoundError/AbortError) to ERR_HW_DENIED', () => {
    expect(toHardwareError('usb', domError('NotFoundError', 'no device selected')).code).toBe('ERR_HW_DENIED')
    expect(toHardwareError('fileSystemAccess', domError('AbortError', 'picker closed')).code).toBe('ERR_HW_DENIED')
  })
  it('maps NotAllowedError (permission denial) to ERR_HW_DENIED', () => {
    expect(toHardwareError('nfc', domError('NotAllowedError', 'permission denied')).code).toBe('ERR_HW_DENIED')
    expect(toHardwareError('wakeLock', domError('NotAllowedError', 'blocked by policy')).code).toBe('ERR_HW_DENIED')
  })
  it('falls through to ERR_UNKNOWN for unrelated errors', () => {
    expect(toHardwareError('usb', domError('TypeError', 'unexpected')).code).toBe('ERR_UNKNOWN')
  })
})

describe('acquireNative (M2.5 native prompt mapping)', () => {
  it('usb: requestDevice resolves to an unmanaged handle', async () => {
    await expect(
      acquireNative('usb', envWith({ usb: { requestDevice: async () => ({ serialNumber: 'x' }) } })),
    ).resolves.toEqual({})
  })
  it('usb: no-gesture SecurityError rejects ERR_HW_GESTURE_REQUIRED', async () => {
    const usb = {
      requestDevice: async () => {
        throw domError('SecurityError', 'Must be handling a user gesture to show a permission request.')
      },
    }
    await expect(acquireNative('usb', envWith({ usb }))).rejects.toMatchObject({ code: 'ERR_HW_GESTURE_REQUIRED' })
  })
  it('usb: user cancels (NotFoundError) rejects ERR_HW_DENIED', async () => {
    const usb = {
      requestDevice: async () => {
        throw domError('NotFoundError', 'No device selected')
      },
    }
    await expect(acquireNative('usb', envWith({ usb }))).rejects.toMatchObject({ code: 'ERR_HW_DENIED' })
  })
  it('bluetooth: SecurityError rejects ERR_HW_GESTURE_REQUIRED', async () => {
    const bluetooth = {
      requestDevice: async () => {
        throw domError('SecurityError', 'A user gesture is required')
      },
    }
    await expect(acquireNative('bluetooth', envWith({ bluetooth }))).rejects.toMatchObject({ code: 'ERR_HW_GESTURE_REQUIRED' })
  })
  it('nfc: scan denial (NotAllowedError) rejects ERR_HW_DENIED', async () => {
    const NDEFReader = class {
      async scan(): Promise<void> {
        throw domError('NotAllowedError', 'denied')
      }
    }
    await expect(acquireNative('nfc', envWith({}, { NDEFReader }))).rejects.toMatchObject({ code: 'ERR_HW_DENIED' })
  })
  it('wakeLock: success returns a release handle that releases the sentinel', async () => {
    const released = { called: false }
    const wakeLock = {
      request: async () => ({
        release: async () => {
          released.called = true
        },
      }),
    }
    const handle = await acquireNative('wakeLock', envWith({ wakeLock }))
    expect(handle.release).toBeTypeOf('function')
    await handle.release?.()
    expect(released.called).toBe(true)
  })
  it('wakeLock: NotAllowedError rejects ERR_HW_DENIED', async () => {
    const wakeLock = {
      request: async () => {
        throw domError('NotAllowedError', 'unavailable while screen is off')
      },
    }
    await expect(acquireNative('wakeLock', envWith({ wakeLock }))).rejects.toMatchObject({ code: 'ERR_HW_DENIED' })
  })
  it('fileSystemAccess: picker cancel (AbortError) rejects ERR_HW_DENIED', async () => {
    const showOpenFilePicker = async () => {
      throw domError('AbortError', 'picker dismissed')
    }
    await expect(acquireNative('fileSystemAccess', envWith({}, { showOpenFilePicker }))).rejects.toMatchObject({ code: 'ERR_HW_DENIED' })
  })
  it('vibration: never rejects (no prompt)', async () => {
    const vibrate = () => true
    await expect(acquireNative('vibration', envWith({ vibrate }))).resolves.toEqual({})
  })
  it('daemon: no native acquisition in Phase 2', async () => {
    await expect(acquireNative('daemon', emptyEnv())).rejects.toMatchObject({ code: 'ERR_HW_UNSUPPORTED' })
  })
})

describe('PlatformHardwareBridge.acquire', () => {
  it('rejects ERR_HW_UNSUPPORTED for a capability that is not available', async () => {
    const bridge = new PlatformHardwareBridge()
    await bridge.capabilities()
    await expect(bridge.acquire('nfc')).rejects.toMatchObject({ code: 'ERR_HW_UNSUPPORTED' })
    await expect(bridge.acquire('daemon')).rejects.toMatchObject({ code: 'ERR_HW_UNSUPPORTED' })
  })
})