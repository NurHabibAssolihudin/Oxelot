import { PersistentSyncQueue, FetchSyncDelivery, SYNC_TAG, WebLock } from './core/sync'
import type { SyncService } from './core/sync'
import { WorkerKv } from './sw-kv'

export interface SwSyncConfig {
  serverUrl: string
}

export class SwSync {
  private readonly sync: SyncService

  constructor(config: SwSyncConfig) {
    this.sync = new PersistentSyncQueue(
      new WorkerKv(),
      new FetchSyncDelivery({ serverUrl: config.serverUrl }),
      // The SW takes the same `oxelot-sync` Web Lock the page-side queue uses,
      // so a SW flush and a tab flush can never drain the shared queue at the
      // same time (M2.3 slice 3.3: exactly one active flusher).
      new WebLock((self as unknown as { navigator?: { locks?: LockManager } }).navigator?.locks),
    )
  }

  flush(): Promise<{ delivered: number; deadLetters: number }> {
    return this.sync.flush()
  }

  status(): Promise<{ pending: number; deadLetters: number }> {
    return this.sync.status()
  }
}

export { SYNC_TAG }

const swScope = self as unknown as ServiceWorkerGlobalScope

let serverUrl: string | undefined
let sync: SwSync | null = null

function getSync(url: string): SwSync {
  if (!sync) sync = new SwSync({ serverUrl: url })
  return sync
}

// Install immediately and take control so a hard refresh activates the SW that
// may already be caching the sync queue.
swScope.addEventListener('install', () => {
  void swScope.skipWaiting()
})

swScope.addEventListener('activate', (event) => {
  event.waitUntil(swScope.clients.claim().catch(() => undefined))
})

interface SwMessage {
  type?: string
  serverUrl?: string
}

/**
 * Page → SW relay:
 * - `{ type: 'oxelot-config', serverUrl }` wires the sync queue before any sync.
 * - `{ type: 'oxelot-sync' }` triggers an explicit flush; the result is posted
 *   back to the caller as `{ type: 'oxelot-sync-result', delivered, deadLetters }`.
 */
swScope.addEventListener('message', (event) => {
  const data = event.data as SwMessage | undefined
  if (!data || typeof data !== 'object') return
  if (data.type === 'oxelot-config' && typeof data.serverUrl === 'string') {
    serverUrl = data.serverUrl
    getSync(serverUrl)
    return
  }
  if (data.type === 'oxelot-sync' && typeof serverUrl === 'string') {
    const source = event.source
    const reply = (m: Record<string, unknown>): void => {
      if (source && 'postMessage' in source) {
        ;(source as { postMessage(m: unknown): void }).postMessage({ type: 'oxelot-sync-result', ...m })
      }
    }
    event.waitUntil(
      getSync(serverUrl)
        .flush()
        .then((result) => reply(result))
        .catch((err: unknown) => {
          reply({
            delivered: 0,
            deadLetters: 0,
            error: err instanceof Error ? err.message : String(err),
          })
        }),
    )
  }
})

// Connectivity-restore signal: the page registers the `oxelot-sync` one-shot tag
// (`registration.sync.register`). When the browser wakes the SW after the
// connection returns, drain the shared queue in the background.
swScope.addEventListener('sync', (event) => {
  const e = event as Event & { tag: string; waitUntil(p: Promise<unknown>): void }
  if (e.tag !== SYNC_TAG || typeof serverUrl !== 'string') return
  e.waitUntil(getSync(serverUrl).flush())
})
