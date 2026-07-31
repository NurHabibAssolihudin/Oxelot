import type { OxelotMutation, SyncState } from './envelope'
import { serializeMutation, deserializeMutation } from './envelope'
import { nextRetryDelayMs, isDeadLetter } from './scheduler'
import { oxError } from '../../errors'

const QUEUE_KEY = 'oxelot.sync.queue'
const DEAD_KEY = 'oxelot.sync.dead'

export interface KvLike {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
}

export interface SyncDelivery {
  deliver(m: OxelotMutation): Promise<void>
}

export interface SyncService {
  enqueue(m: OxelotMutation): Promise<void>
  flush(): Promise<{ delivered: number; deadLetters: number }>
  status(): Promise<{ pending: number; deadLetters: number }>
  onStateChange(cb: (s: SyncState) => void): () => void
}

export class PersistentSyncQueue implements SyncService {
  private readonly listeners = new Set<(s: SyncState) => void>()
  private flushing = false

  constructor(
    private readonly kv: KvLike,
    private readonly deliver: SyncDelivery,
  ) {}

  async enqueue(m: OxelotMutation): Promise<void> {
    const queue = (await this.kv.get<OxelotMutation[]>(QUEUE_KEY)) ?? []
    queue.push(m)
    await this.kv.set(QUEUE_KEY, queue)
    this.emit({ kind: 'queued', pending: queue.length })
  }

  async flush(): Promise<{ delivered: number; deadLetters: number }> {
    if (this.flushing) return { delivered: 0, deadLetters: 0 }
    this.flushing = true
    const result = { delivered: 0, deadLetters: 0 }
    try {
      const queue = (await this.kv.get<OxelotMutation[]>(QUEUE_KEY)) ?? []
      const dead = (await this.kv.get<OxelotMutation[]>(DEAD_KEY)) ?? []
      if (queue.length === 0) {
        this.emit({ kind: 'idle' })
        return result
      }
      this.emit({ kind: 'syncing', pending: queue.length })

      const remaining: OxelotMutation[] = []
      for (const m of queue) {
        m.attempts += 1
        try {
          await this.deliver.deliver(m)
          result.delivered++
        } catch (err) {
          m.lastError = err instanceof Error ? err.message : String(err)
          if (isDeadLetter(m.attempts)) {
            dead.push(m)
            result.deadLetters++
          } else {
            remaining.push(m)
          }
        }
      }
      await this.kv.set(QUEUE_KEY, remaining)
      await this.kv.set(DEAD_KEY, dead)
      this.emit(
        remaining.length > 0
          ? { kind: 'queued', pending: remaining.length }
          : result.deadLetters > 0
            ? { kind: 'dead_letter', pending: 0, deadLetters: dead.length }
            : { kind: 'idle' },
      )
      return result
    } finally {
      this.flushing = false
    }
  }

  async status(): Promise<{ pending: number; deadLetters: number }> {
    const queue = (await this.kv.get<OxelotMutation[]>(QUEUE_KEY)) ?? []
    const dead = (await this.kv.get<OxelotMutation[]>(DEAD_KEY)) ?? []
    return { pending: queue.length, deadLetters: dead.length }
  }

  onStateChange(cb: (s: SyncState) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  private emit(state: SyncState): void {
    for (const cb of this.listeners) cb(state)
  }
}

export interface FetchSyncDeliveryOptions {
  serverUrl: string
  fetchImpl?: typeof fetch
}

export class FetchSyncDelivery implements SyncDelivery {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly options: FetchSyncDeliveryOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  async deliver(m: OxelotMutation): Promise<void> {
    let res: Response
    try {
      res = await this.fetchImpl(this.options.serverUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: serializeMutation(m),
      })
    } catch (err) {
      throw oxError('ERR_SYNC_NETWORK', 'network failure during sync flush', err)
    }
    if (res.ok) return
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      throw oxError('ERR_SYNC_NETWORK', `retryable status ${res.status}`)
    }
    throw oxError('ERR_SYNC_REJECTED', `permanent status ${res.status}`)
  }
}

export const retryDelay = nextRetryDelayMs
export { deserializeMutation }
