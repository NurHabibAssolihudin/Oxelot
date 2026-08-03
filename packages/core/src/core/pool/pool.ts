import { OxelotBridge } from './bridge'
import { oxError } from '../../errors'
import type { OxelotEvent } from '../types'
import type { StorageBackend } from '../storage'

const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 8

export interface PoolRequestOptions {
  transfer?: ArrayBuffer[]
}

export interface WorkerInitConfig {
  dbName?: string
  storageBackend?: StorageBackend
  dbEnabled?: boolean
}

interface QueuedJob {
  op: string
  payload?: unknown
  transfer?: ArrayBuffer[] | undefined
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

export class OxelotPool {
  private readonly bridges: OxelotBridge[] = []
  private readonly available: number[] = []
  private readonly queue: QueuedJob[] = []
  private inFlight = 0
  private readonly concurrency: number
  private readonly eventListeners = new Set<(ev: OxelotEvent) => void>()

  constructor(
    private readonly createWorker: (index: number) => Worker,
    concurrency = DEFAULT_CONCURRENCY,
  ) {
    this.concurrency = Math.min(Math.max(concurrency, 1), MAX_CONCURRENCY)
  }

  async start(config?: WorkerInitConfig): Promise<void> {
    for (let i = 0; i < this.concurrency; i++) {
      let worker: Worker
      try {
        worker = this.createWorker(i)
      } catch (err) {
        throw oxError('ERR_WORKER_SPAWN', `failed to spawn worker ${i}`, err)
      }
      const bridge = new OxelotBridge(worker)
      bridge.onEvent((name, payload) => this.dispatchEvent({ type: 'event', name, payload }))
      worker.addEventListener('error', (e) => {
        this.dispatchEvent({ type: 'worker-error', worker: i, message: e.message })
      })
      this.bridges.push(bridge)
      if (config) await bridge.request('config', config)
      this.available.push(i)
    }
  }

  request<T>(op: string, payload?: unknown, options?: PoolRequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ op, payload, transfer: options?.transfer, resolve: resolve as (v: unknown) => void, reject })
      this.pump()
    })
  }

  load(): number {
    return this.inFlight / this.concurrency
  }

  onEvent(cb: (ev: OxelotEvent) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  async dispose(): Promise<void> {
    this.queue.length = 0
    this.eventListeners.clear()
    for (const bridge of this.bridges) {
      bridge.terminate()
    }
    this.bridges.length = 0
    this.available.length = 0
    this.inFlight = 0
  }

  private dispatchEvent(ev: OxelotEvent): void {
    for (const cb of this.eventListeners) cb(ev)
  }

  private pump(): void {
    while (this.available.length > 0 && this.queue.length > 0) {
      const idx = this.available.shift()!
      const job = this.queue.shift()!
      const bridge = this.bridges[idx]!
      this.inFlight++
      void bridge
        .request(job.op, job.payload, job.transfer)
        .then((v) => job.resolve(v))
        .catch((e: unknown) => {
          job.reject(e instanceof Error ? e : new Error(String(e)))
        })
        .finally(() => {
          this.inFlight--
          this.available.push(idx)
          this.pump()
        })
    }
  }
}
