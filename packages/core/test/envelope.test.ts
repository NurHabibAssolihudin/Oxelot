import { describe, it, expect } from 'vitest'
import { serializeMutation, deserializeMutation } from '../src/core/sync/envelope'
import type { OxelotMutation } from '../src/core/sync/envelope'

const m: OxelotMutation = {
  id: 'abc-123',
  schemaVersion: 1,
  collection: 'orders',
  op: 'upsert',
  payload: { total: 9.99 },
  createdAt: 1700000000000,
  attempts: 0,
}

describe('envelope', () => {
  it('round-trips through serialize/deserialize', () => {
    expect(deserializeMutation(serializeMutation(m))).toEqual(m)
  })

  it('normalizes undefined fields to null in JSON', () => {
    const withError: OxelotMutation = { ...m, lastError: 'boom' }
    const parsed = JSON.parse(serializeMutation(withError)) as { lastError: string }
    expect(parsed.lastError).toBe('boom')
  })

  it('rejects envelopes with wrong schemaVersion', () => {
    const bad = { ...m, schemaVersion: 2 as const }
    expect(() => deserializeMutation(JSON.stringify(bad))).toThrow('invalid mutation envelope')
  })

  it('rejects malformed JSON', () => {
    expect(() => deserializeMutation('not json')).toThrow()
  })
})
