export interface OxelotMutation {
  id: string
  schemaVersion: 1
  collection: string
  op: 'upsert' | 'delete'
  payload: unknown
  createdAt: number
  attempts: number
  lastError?: string
}

export type SyncState =
  | { kind: 'idle' }
  | { kind: 'queued'; pending: number }
  | { kind: 'syncing'; pending: number }
  | { kind: 'dead_letter'; pending: number; deadLetters: number }

export function serializeMutation(m: OxelotMutation): string {
  return JSON.stringify(m, (_k: string, v: unknown): unknown => (v === undefined ? null : v))
}

export function deserializeMutation(json: string): OxelotMutation {
  const parsed = JSON.parse(json) as Partial<OxelotMutation>
  if (
    typeof parsed.id !== 'string' ||
    parsed.schemaVersion !== 1 ||
    typeof parsed.collection !== 'string' ||
    (parsed.op !== 'upsert' && parsed.op !== 'delete') ||
    typeof parsed.createdAt !== 'number' ||
    typeof parsed.attempts !== 'number'
  ) {
    throw new Error('invalid mutation envelope')
  }
  return parsed as OxelotMutation
}
