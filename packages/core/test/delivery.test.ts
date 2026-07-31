import { describe, it, expect, vi } from 'vitest'
import { FetchSyncDelivery } from '../src/core/sync/queue'
import type { OxelotMutation } from '../src/core/sync/envelope'

const m: OxelotMutation = {
  id: 'a',
  schemaVersion: 1,
  collection: 'orders',
  op: 'upsert',
  payload: {},
  createdAt: 1,
  attempts: 0,
}

describe('FetchSyncDelivery', () => {
  it('accepts 2xx', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }))
    const delivery = new FetchSyncDelivery({ serverUrl: 'https://x.test/sync', fetchImpl })
    await expect(delivery.deliver(m)).resolves.toBeUndefined()
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://x.test/sync',
      expect.objectContaining({ method: 'POST' }),
    )
  })

  it('classifies 5xx as transient network errors', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 503 }))
    const delivery = new FetchSyncDelivery({ serverUrl: 'https://x.test/sync', fetchImpl })
    await expect(delivery.deliver(m)).rejects.toMatchObject({ code: 'ERR_SYNC_NETWORK' })
  })

  it('classifies 4xx as permanent rejections', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 400 }))
    const delivery = new FetchSyncDelivery({ serverUrl: 'https://x.test/sync', fetchImpl })
    await expect(delivery.deliver(m)).rejects.toMatchObject({ code: 'ERR_SYNC_REJECTED' })
  })

  it('classifies network errors as transient', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'))
    const delivery = new FetchSyncDelivery({ serverUrl: 'https://x.test/sync', fetchImpl })
    await expect(delivery.deliver(m)).rejects.toMatchObject({ code: 'ERR_SYNC_NETWORK' })
  })
})
