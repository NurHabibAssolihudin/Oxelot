import type { OxelotMutation, SyncState } from './envelope'
import { serializeMutation, deserializeMutation } from './envelope'
import { nextRetryDelayMs, isDeadLetter } from './scheduler'
import { oxError } from '../../errors'

const QUEUE_KEY = 'oxelot.sync.queue'
const DEAD_KEY = 'oxelot.sync.dead'
const SYNC_LOCK = 'oxelot-sync'
export const SYNC_TAG = 'oxelot-sync'

export interface KvLike {
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
}

/** Structural lock manager; satisfied by `WebLock`. */
export interface SyncLock {
  tryWithLock<T>(name: string, fn: () => Promise<T>): Promise<{ acquired: boolean; result?: T }>
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
    private readonly lock?: SyncLock,
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
    try {
      if (this.lock) {
        const held = await this.lock.tryWithLock(SYNC_LOCK, () => this.drain())
        if (!held.acquired) return { delivered: 0, deadLetters: 0 }
        return held.result ?? { delivered: 0, deadLetters: 0 }
      }
      return await this.drain()
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

  /**
   * Drain the queue, delivering only envelopes that are due (no pending backoff
   * period). Transient failures increment `attempts`, stamp `nextRetryAt`, and
   * are kept for a later flush; permanent failures are quarantined as dead
   * letters.
   */
  private async drain(): Promise<{ delivered: number; deadLetters: number }> {
    const result = { delivered: 0, deadLetters: 0 }
    const queue = (await this.kv.get<OxelotMutation[]>(QUEUE_KEY)) ?? []
    const dead = (await this.kv.get<OxelotMutation[]>(DEAD_KEY)) ?? []
    if (queue.length === 0) {
      this.emit({ kind: 'idle' })
      return result
    }
    this.emit({ kind: 'syncing', pending: queue.length })

    const now = Date.now()
    const notDue: OxelotMutation[] = []
    const remaining: OxelotMutation[] = []
    for (const m of queue) {
      if (m.nextRetryAt != null && m.nextRetryAt > now) {
        notDue.push(m)
        continue
      }
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
          m.nextRetryAt = now + nextRetryDelayMs(m.attempts)
          remaining.push(m)
        }
      }
    }
    const pending = remaining.length + notDue.length
    await this.kv.set(QUEUE_KEY, [...notDue, ...remaining])
    await this.kv.set(DEAD_KEY, dead)
    this.emit(
      pending > 0
        ? { kind: 'queued', pending }
        : result.deadLetters > 0
          ? { kind: 'dead_letter', pending: 0, deadLetters: dead.length }
          : { kind: 'idle' },
    )
    return result
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
  private readonly fetchImpl: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

  constructor(private readonly options: FetchSyncDeliveryOptions) {
    // `fetch` is a method on the global scope (Window/WorkerGlobalScope) and
    // throws "Illegal invocation" when called through a stored reference. Bind
    // it so flush works from both the page and the service worker.
    this.fetchImpl = (options.fetchImpl ?? fetch).bind(globalThis)
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
      const cause = err instanceof Error ? err.message : String(err)
      throw oxError('ERR_SYNC_NETWORK', `network failure during sync flush (${cause})`, err)
    }
    if (res.ok) return
    if (res.status >= 500 || res.status === 408 || res.status === 429) {
      throw oxError('ERR_SYNC_NETWORK', `retryable status ${res.status}`)
    }
    throw oxError('ERR_SYNC_REJECTED', `permanent status ${res.status}`)
  }
}

export const retryDelay = nextRetryDelayMs
export { deserializeMutation, SYNC_LOCK }