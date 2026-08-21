import { describe, expect, it } from 'vitest'
import { makeStorageMutation, newMutationId, storageCollection } from '../src/core/sync'

describe('makeStorageMutation (D8 §6.3.1 optimistic envelope)', () => {
  it('builds an upsert envelope namespaced by the storage key', () => {
    const m = makeStorageMutation('greeting', { hello: 'oxelot' }, { now: () => 123, newId: () => 'id-1' })
    expect(m).toEqual({
      id: 'id-1',
      schemaVersion: 1,
      collection: 'storage:greeting',
      op: 'upsert',
      payload: { hello: 'oxelot' },
      createdAt: 123,
      attempts: 0,
    })
  })

  it('builds a delete envelope when op: delete is requested', () => {
    const m = makeStorageMutation('greeting', null, { now: () => 124, newId: () => 'id-2', op: 'delete' })
    expect(m).toEqual({
      id: 'id-2',
      schemaVersion: 1,
      collection: 'storage:greeting',
      op: 'delete',
      payload: null,
      createdAt: 124,
      attempts: 0,
    })
  })

  it('distinct writes to the same key produce distinct envelope ids', () => {
    const a = makeStorageMutation('k', 1)
    const b = makeStorageMutation('k', 2)
    expect(a.id).not.toBe(b.id)
  })

  it('storageCollection namespaces the key', () => {
    expect(storageCollection('orders/42')).toBe('storage:orders/42')
  })

  it('newMutationId returns non-empty unique values', () => {
    expect(newMutationId()).toBeTruthy()
    expect(newMutationId()).not.toBe(newMutationId())
  })
})