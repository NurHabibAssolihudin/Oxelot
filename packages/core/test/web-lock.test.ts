import { describe, it, expect } from 'vitest'
import { WebLock } from '../src/core/sync/web-lock'

describe('WebLock', () => {
  it('falls back to direct execution when locks are unavailable', async () => {
    const lock = new WebLock(undefined)
    expect(lock.isSupported).toBe(false)
    await expect(lock.withLock('x', async () => 42)).resolves.toBe(42)
  })
})
