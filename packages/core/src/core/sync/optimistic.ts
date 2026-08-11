import type { OxelotMutation } from './envelope'

/** Namespace for storage-backed envelopes (§6.3.1): `storage:${key}`. */
export function storageCollection(key: string): string {
  return `storage:${key}`
}

/** Stable-ish UUIDv4 via `crypto.randomUUID`; deterministic fallback for non-web runtimes. */
export function newMutationId(): string {
  const c = (globalThis as { crypto?: { randomUUID?(): string } }).crypto
  if (c?.randomUUID) return c.randomUUID()
  return `ox-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

export interface MutationClock {
  now?: () => number
  newId?: () => string
}

/**
 * Build the envelope a `useOxelotStorage().write(value)` enqueues (D8 /
 * §6.3.1): an `upsert` mutation whose `collection` namespaces the storage key,
 * so the server can route `storage:${key}` payloads back to the right document.
 */
export function makeStorageMutation(key: string, value: unknown, opts: MutationClock = {}): OxelotMutation {
  return {
    id: (opts.newId ?? newMutationId)(),
    schemaVersion: 1,
    collection: storageCollection(key),
    op: 'upsert',
    payload: value,
    createdAt: (opts.now ?? Date.now)(),
    attempts: 0,
  }
}