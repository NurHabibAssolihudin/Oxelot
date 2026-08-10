import { describe, expect, it, vi } from 'vitest'
import {
  detectSyncCapabilities,
  registerPeriodicSync,
  PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS,
} from '../src/core/sync'
import { SYNC_TAG } from '../src/core/sync'

describe('detectSyncCapabilities', () => {
  it('reports false/false when there is no registration', async () => {
    await expect(detectSyncCapabilities(undefined)).resolves.toEqual({ backgroundSync: false, periodicSync: false })
  })

  it('reports backgroundSync true when only registration.sync exists', async () => {
    await expect(detectSyncCapabilities({ sync: {} })).resolves.toEqual({ backgroundSync: true, periodicSync: false })
  })

  it('reports both true when sync + periodicSync exist', async () => {
    await expect(detectSyncCapabilities({ sync: {}, periodicSync: { register: async () => undefined } })).resolves.toEqual({
      backgroundSync: true,
      periodicSync: true,
    })
  })

  it('reports periodicSync true when only registration.periodicSync exists', async () => {
    await expect(detectSyncCapabilities({ periodicSync: { register: async () => undefined } })).resolves.toEqual({
      backgroundSync: false,
      periodicSync: true,
    })
  })
})

describe('registerPeriodicSync (M2.4 slice 4.1 no-op fallback)', () => {
  it('is a no-op when the feature is disabled', async () => {
    await expect(registerPeriodicSync({ periodicSync: { register: async () => undefined } }, { enabled: false })).resolves.toEqual({ registered: false })
  })

  it('is a no-op when registration.periodicSync is missing (Firefox/Safari)', async () => {
    await expect(registerPeriodicSync({ sync: {} }, { enabled: true })).resolves.toEqual({ registered: false })
  })

  it("registers the oxelot-sync tag with the default min interval when enabled === true", async () => {
    const register = vi.fn(async () => undefined)
    const result = await registerPeriodicSync({ periodicSync: { register } }, { enabled: true })
    expect(result).toEqual({ registered: true, minIntervalMs: PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS })
    expect(register).toHaveBeenCalledWith(SYNC_TAG, { minInterval: PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS })
  })

  it('uses the numeric min interval when enabled is a number', async () => {
    const register = vi.fn(async () => undefined)
    const result = await registerPeriodicSync({ periodicSync: { register } }, { enabled: 18_000_000 })
    expect(result).toEqual({ registered: true, minIntervalMs: 18_000_000 })
    expect(register).toHaveBeenCalledWith(SYNC_TAG, { minInterval: 18_000_000 })
  })

  it('degrades to a no-op with a reported error when register() rejects', async () => {
    const register = vi.fn(async () => {
      throw new Error('NotAllowedError: not installed')
    })
    const result = await registerPeriodicSync({ periodicSync: { register } }, { enabled: true })
    expect(result.registered).toBe(false)
    expect(result.error).toContain('NotAllowedError')
    expect(result.minIntervalMs).toBeUndefined()
  })
})