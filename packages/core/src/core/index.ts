import { OxelotPool } from './pool/pool'
import type { WorkerInitConfig } from './pool/pool'
import { PooledDatabase } from './db'
import { PlatformHardwareBridge } from './hardware'
import type { HardwareBridge } from './hardware'
import { PersistentSyncQueue, FetchSyncDelivery } from './sync'
import type { SyncService, KvLike, OxelotMutation, SyncState } from './sync'
import { oxError } from '../errors'
import type { OxelotEvent, DatabaseFacade } from './types'
import type { StorageBackend, OxelotFile } from './storage'

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
  features?: {
    daemon?: boolean
    periodicSync?: boolean
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
  private readonly listeners = new Set<(ev: OxelotEvent) => void>()
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
    pool.onEvent((ev) => {
      if (ev.type === 'worker-error') this.emit(ev)
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
    await pool.start(workerConfig)

    const sync: SyncService =
      config.sync !== undefined
        ? new PersistentSyncQueue(new WorkerKv(pool), new FetchSyncDelivery({ serverUrl: config.sync.serverUrl }))
        : new NoopSync()

    const oxelot = new Oxelot(pool, backend, sync, config)
    oxelot.readyEmitted = true
    return oxelot
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
    await this.pool.dispose()
  }

  static enqueue(ox: Oxelot, m: OxelotMutation): Promise<void> {
    return ox.sync.enqueue(m)
  }

  private emit(ev: OxelotEvent): void {
    for (const cb of this.listeners) cb(ev)
  }
}

class NoopSync implements SyncService {
  async enqueue(): Promise<void> {}
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
