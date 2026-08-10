import { OxelotPool } from './pool/pool'
import type { WorkerInitConfig } from './pool/pool'
import { PooledDatabase } from './db'
import { PlatformHardwareBridge } from './hardware'
import type { HardwareBridge } from './hardware'
import { PersistentSyncQueue, FetchSyncDelivery, WebLock, SYNC_TAG } from './sync'
import {
  detectSyncCapabilities,
  registerPeriodicSync,
  PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS,
} from './sync'
import type { SyncService, KvLike, OxelotMutation, SyncState, SyncCapabilities } from './sync'
import { oxError } from '../errors'
import type { OxelotEvent, DatabaseFacade } from './types'
import type { StorageBackend, OxelotFile } from './storage'
import { StorageBroadcast, getSourceTab } from './broadcast'
import type { StorageChangeMessage } from './broadcast'

export interface SyncConfig {
  serverUrl: string
  backoffMultiplier?: number
  maxBackoffMs?: number
}

export interface OxelotConfig {
  workers?: number
  dbName?: string
  dbEnabled?: boolean
  storageBackend?: StorageBackend
  sync?: SyncConfig
  registerSW?: boolean
  /** Service-worker script URL. Default './sw.js' (copy `@oxelot/core/dist/sw.js`). */
  swUrl?: string
  features?: {
    daemon?: boolean
    /** `true` registers the `oxelot-sync` periodic tag at the default 12 h min interval; a number sets the min interval in ms (Chrome clamps to its own minimum). Unsupported engines degrade to a no-op. */
    periodicSync?: boolean | number
  }
}

export interface StorageFacade {
  readonly backend: StorageBackend
  open(name: string, mode?: 'read' | 'readwrite'): Promise<OxelotFile>
  remove(name: string): Promise<void>
  entries(): Promise<string[]>
  get<T>(key: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
}

const WORKER_URL = /* @__PURE__ */ new URL('./worker.js', import.meta.url)

/** `sync`/`periodicSync` are not part of the DOM lib typings used here. */
type SyncRegistration = ServiceWorkerRegistration & {
  sync?: { register(tag: string): Promise<void> }
  periodicSync?: { register(tag: string, opts?: { minInterval: number }): Promise<void> }
}

class WorkerKv implements KvLike {
  constructor(private readonly pool: OxelotPool) {}

  get<T>(key: string): Promise<T | null> {
    return this.pool.request<T | null>('kv.get', { key })
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.pool.request('kv.set', { key, value })
  }
}

class WorkerStorageFacade implements StorageFacade {
  constructor(
    private readonly pool: OxelotPool,
    readonly backend: StorageBackend,
  ) {}

  async open(name: string, mode: 'read' | 'readwrite' = 'readwrite'): Promise<OxelotFile> {
    void mode
    return {
      size: async () => {
        const v = await this.pool.request<number>('storage.getSize', { name })
        return v
      },
      readBytes: async (offset, length) => {
        const buf = await this.pool.request<ArrayBuffer>('storage.readBytes', { name, offset, length })
        return new Uint8Array(buf)
      },
      writeBytes: async (offset, data) => {
        await this.pool.request('storage.writeBytes', { name, offset, data }, { transfer: [data.buffer as ArrayBuffer] })
      },
      truncate: async (size) => {
        await this.pool.request('storage.truncate', { name, size })
      },
      sync: async () => undefined,
      close: async () => undefined,
    }
  }

  remove(name: string): Promise<void> {
    return this.pool.request('storage.remove', { name })
  }

  entries(): Promise<string[]> {
    return this.pool.request('storage.entries')
  }

  get<T>(key: string): Promise<T | null> {
    return this.pool.request<T | null>('kv.get', { key })
  }

  set<T>(key: string, value: T): Promise<void> {
    return this.pool.request('kv.set', { key, value })
  }
}

export class Oxelot {
  readonly storage: StorageFacade
  readonly db: DatabaseFacade
  readonly sync: SyncService
  readonly hardware: HardwareBridge
  readonly pool: OxelotPool
  readonly sourceTab: string
  private readonly broadcast: StorageBroadcast
  private readonly listeners = new Set<(ev: OxelotEvent) => void>()
  private readonly onlineHandler = (): void => {
    void this.sync.flush()
  }
  private readonly swUrl: string
  private readonly serverUrl: string | undefined
  private readonly periodicSync: boolean | number | undefined
  private syncCaps: SyncCapabilities | null = null
  private swRegistered = false
  private readyEmitted = false
  private disposed = false

  private constructor(
    pool: OxelotPool,
    backend: StorageBackend,
    sync: SyncService,
    config: OxelotConfig,
  ) {
    this.pool = pool
    this.storage = new WorkerStorageFacade(pool, backend)
    this.db = new PooledDatabase(pool, config.dbName ?? 'oxelot.db', config.dbEnabled ?? true)
    this.sync = sync
    this.hardware = new PlatformHardwareBridge()
    this.broadcast = new StorageBroadcast()
    this.sourceTab = getSourceTab()
    this.swUrl = config.swUrl ?? './sw.js'
    this.serverUrl = config.sync?.serverUrl
    this.periodicSync = config.features?.periodicSync
    sync.onStateChange((state) => {
      if (!this.disposed) this.emit({ type: 'sync-state', state })
    })
    pool.onEvent((ev) => {
      if (ev.type === 'worker-error') {
        this.emit(ev)
        return
      }
      if (ev.type === 'event' && ev.name === 'storage-change') {
        const msg = ev.payload as StorageChangeMessage | undefined
        if (typeof msg?.key === 'string') {
          this.emit({ type: 'storage-change', key: msg.key, sourceTab: msg.sourceTab })
          this.broadcast.broadcast(msg)
        }
      }
    })
    this.broadcast.onRemote((msg) => {
      if (!this.disposed) this.emit({ type: 'storage-change', key: msg.key, sourceTab: msg.sourceTab })
    })
  }

  static async init(config: OxelotConfig = {}): Promise<Oxelot> {
    if (typeof Worker === 'undefined') {
      throw oxError('ERR_WORKER_SPAWN', 'Web Workers are not available in this environment')
    }
    const workers = config.workers ?? 2
    const backend = config.storageBackend ?? 'auto'

    const pool = new OxelotPool(
      () => new Worker(WORKER_URL, { type: 'module' }),
      workers,
    )
    const workerConfig: WorkerInitConfig = {}
    if (config.dbName !== undefined) workerConfig.dbName = config.dbName
    if (backend !== 'auto') workerConfig.storageBackend = backend
    if (config.dbEnabled === false) workerConfig.dbEnabled = false
    const sourceTab = getSourceTab()
    workerConfig.sourceTab = sourceTab
    await pool.start(workerConfig)

    const sync: SyncService =
      config.sync !== undefined
        ? new PersistentSyncQueue(
            new WorkerKv(pool),
            new FetchSyncDelivery({ serverUrl: config.sync.serverUrl }),
            new WebLock((globalThis as unknown as { navigator?: Navigator }).navigator?.locks),
          )
        : new NoopSync()

    const oxelot = new Oxelot(pool, backend, sync, config)
    oxelot.readyEmitted = true
    if (typeof globalThis.addEventListener === 'function') {
      globalThis.addEventListener('online', oxelot.onlineHandler)
    }
    if (config.registerSW === true) void oxelot.registerServiceWorker()
    return oxelot
  }

  /**
   * Register the bundled service worker (M2.1). Registers `swUrl` (default
   * `./sw.js`; consumers copy `@oxelot/core/dist/sw.js` into their public
   * directory). When a `sync` config is present, sends the server URL to the SW
   * and registers the `oxelot-sync` one-shot background sync tag so the SW
   * drains the shared queue on connectivity restore. Idempotent; registration
   * failure never breaks the app.
   */
  async registerServiceWorker(): Promise<void> {
    if (this.swRegistered) return
    this.swRegistered = true
    const nav = (globalThis as unknown as { navigator?: Navigator }).navigator
    if (typeof nav === 'undefined' || !('serviceWorker' in nav)) return
    try {
      const registration = await nav.serviceWorker.register(this.swUrl, { type: 'module' })
      if (this.serverUrl !== undefined) {
        const configMessage = (): { type: string; serverUrl: string } => ({
          type: 'oxelot-config',
          serverUrl: this.serverUrl as string,
        })
        const sendConfig = (): void => {
          const sw = registration.active
          if (sw) sw.postMessage(configMessage())
        }
        // Wait for an active worker before wiring config: posting into a
        // not-yet-activated registration drops the message (no SW context exists
        // to receive it). skipWaiting/clients.claim activate promptly.
        const ready = await nav.serviceWorker.ready
        const active = ready.active
        if (active) active.postMessage(configMessage())
        nav.serviceWorker.addEventListener('controllerchange', sendConfig)

        // Surface capability + register tags on the actual registration. Both
        // degrade to no-ops where unsupported (Safari/Firefox), never throwing.
        const reg = registration as SyncRegistration
        this.syncCaps = await detectSyncCapabilities(reg)
        if (reg.sync) {
          try {
            await reg.sync.register(SYNC_TAG)
          } catch {
            // Background Sync unsupported (Safari/older Chrome): the page-side
            // `online` listener still triggers flush (see `Oxelot.enqueue`).
          }
        }
        const periodic = await registerPeriodicSync(reg, {
          enabled: this.periodicSync,
          defaultMinIntervalMs: PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS,
        })
        if (periodic.registered) {
          console.info(`[oxelot] periodic background sync active (tag "${SYNC_TAG}", min interval ${periodic.minIntervalMs} ms)`)
        } else if (this.periodicSync && !periodic.error) {
          console.info('[oxelot] periodic background sync unavailable (registration.periodicSync missing); no-op fallback')
        } else if (this.periodicSync && periodic.error) {
          console.info(`[oxelot] periodic background sync registration rejected (${periodic.error}); no-op fallback`)
        }
      }
    } catch {
      // SW registration failure must not break the app (registerSW is opt-in).
    }
  }

  /**
   * Report which background-sync mechanisms are available in this environment
   * (M2.4 slice 4.2). `backgroundSync` ⇔ `registration.sync` (connectivity
   * restore); `periodicSync` ⇔ `registration.periodicSync` (periodic cadence).
   * Cached after the first call; never throws.
   */
  async syncCapabilities(): Promise<SyncCapabilities> {
    if (this.syncCaps) return this.syncCaps
    this.syncCaps = await detectSyncCapabilities()
    return this.syncCaps
  }

  on(cb: (ev: OxelotEvent) => void): () => void {
    this.listeners.add(cb)
    if (this.readyEmitted) queueMicrotask(() => cb({ type: 'ready' }))
    return () => this.listeners.delete(cb)
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.listeners.clear()
    this.broadcast.dispose()
    if (typeof globalThis.removeEventListener === 'function') {
      globalThis.removeEventListener('online', this.onlineHandler)
    }
    await this.pool.dispose()
  }

  static enqueue(ox: Oxelot, m: OxelotMutation): Promise<void> {
    return ox.sync.enqueue(m).then(() => {
      // §6.3.1: flush immediately when online; the SW/online listener handles
      // the offline→online transition. flush() is lock-guarded + backoff-aware.
      const nav = (globalThis as unknown as { navigator?: Navigator }).navigator
      if (typeof nav !== 'undefined' && nav.onLine) void ox.sync.flush()
    })
  }

  private emit(ev: OxelotEvent): void {
    for (const cb of this.listeners) cb(ev)
  }
}

class NoopSync implements SyncService {
  async enqueue(): Promise<void> {}
  async peek(): Promise<null> {
    return null
  }
  async flush(): Promise<{ delivered: number; deadLetters: number }> {
    return { delivered: 0, deadLetters: 0 }
  }
  async status(): Promise<{ pending: number; deadLetters: number }> {
    return { pending: 0, deadLetters: 0 }
  }
  onStateChange(): () => void {
    return () => undefined
  }
}

export type { SyncState }
