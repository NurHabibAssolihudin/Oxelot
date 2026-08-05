import { OxelotBridge } from './bridge'
import { oxError } from '../../errors'
import type { OxelotEvent } from '../types'
import type { StorageBackend } from '../storage'

const DEFAULT_CONCURRENCY = 2
const MAX_CONCURRENCY = 8
const MAX_REDISPATCHES = 1
const RESPAWN_ATTEMPTS = 5
const RESPAWN_DELAY_MS = 250

export interface PoolRequestOptions {
  transfer?: ArrayBuffer[]
  /** Pin the request to a specific worker index. db ops must hit one worker. */
  worker?: number
}

export interface WorkerInitConfig {
  dbName?: string
  storageBackend?: StorageBackend
  dbEnabled?: boolean
  /** Stable per-tab id; storage-change events carry it so tabs can ignore echoes. */
  sourceTab?: string
}

interface QueuedJob {
  op: string
  payload?: unknown
  transfer?: ArrayBuffer[] | undefined
  worker?: number
  resolve: (v: unknown) => void
  reject: (e: Error) => void
  /** Number of times this request has been re-dispatched after a worker crash. */
  redispatchCount: number
  /** Guards double-settling when a stale dispatch finally runs after a crash. */
  state: 'queued' | 'in-flight' | 'redispatching' | 'settled'
}

export class OxelotPool {
  private readonly bridges: (OxelotBridge | undefined)[] = []
  private readonly slotAlive: boolean[] = []
  private available: number[] = []
  private readonly queue: QueuedJob[] = []
  private readonly inFlightJobs = new Map<number, QueuedJob>()
  private inFlight = 0
  private readonly concurrency: number
  private readonly eventListeners = new Set<(ev: OxelotEvent) => void>()
  private config: WorkerInitConfig | undefined
  private disposed = false
  private readonly respawnAttempts = new Map<number, number>()

  constructor(
    private readonly createWorker: (index: number) => Worker,
    concurrency = DEFAULT_CONCURRENCY,
  ) {
    this.concurrency = Math.min(Math.max(concurrency, 1), MAX_CONCURRENCY)
  }

  async start(config?: WorkerInitConfig): Promise<void> {
    this.config = config
    const workers: (OxelotBridge | undefined)[] = []
    for (let i = 0; i < this.concurrency; i++) {
      workers[i] = await this.spawnWorker(i)
      this.slotAlive[i] = true
      this.available.push(i)
    }
    this.bridges.push(...workers)
  }

  request<T>(op: string, payload?: unknown, options?: PoolRequestOptions): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const job: QueuedJob = {
        op,
        payload,
        transfer: options?.transfer,
        resolve: resolve as (v: unknown) => void,
        reject,
        redispatchCount: 0,
        state: 'queued',
      }
      if (options?.worker !== undefined) job.worker = options.worker
      this.queue.push(job)
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
    this.disposed = true
    this.queue.length = 0
    this.eventListeners.clear()
    this.respawnAttempts.clear()
    for (const bridge of this.bridges) bridge?.terminate()
    this.bridges.length = 0
    this.available.length = 0
    this.inFlightJobs.clear()
    this.inFlight = 0
  }

  private dispatchEvent(ev: OxelotEvent): void {
    for (const cb of this.eventListeners) cb(ev)
  }

  private isDisposed(): boolean {
    return this.disposed
  }

  private async spawnWorker(index: number): Promise<OxelotBridge> {
    let worker: Worker
    try {
      worker = this.createWorker(index)
    } catch (err) {
      throw oxError('ERR_WORKER_SPAWN', `failed to spawn worker ${index}`, err)
    }
    const bridge = new OxelotBridge(worker)
    bridge.onEvent((name, payload) => this.dispatchEvent({ type: 'event', name, payload }))
    worker.addEventListener('error', (e) => this.handleWorkerError(index, e.message))
    if (this.config) await bridge.request('config', this.config)
    return bridge
  }

  /**
   * Worker crash handling: emit the error, re-dispatch the single in-flight
   * request at most once (workers are single-slot), then respawn the slot.
   * A respawn that fails is retried with bounded backoff; if it never comes
   * back up the slot stays dead and pinned requests remain queued rather than
   * being dispatched against a dead bridge.
   */
  private handleWorkerError(index: number, message: string): void {
    if (this.disposed) return
    this.dispatchEvent({ type: 'worker-error', worker: index, message })

    const job = this.inFlightJobs.get(index)
    if (job) {
      this.inFlight--
      this.inFlightJobs.delete(index)
      this.requeueAfterCrash(job)
    }

    this.slotAlive[index] = false
    this.available = this.available.filter((w) => w !== index)
    this.bridges[index]?.dispose()

    void this.respawn(index)
  }

  private requeueAfterCrash(job: QueuedJob): void {
    if (job.redispatchCount >= MAX_REDISPATCHES) {
      job.state = 'settled'
      job.reject(oxError('ERR_WORKER_SPAWN', `worker crashed while handling "${job.op}"`))
      return
    }
    const requeued: QueuedJob = {
      ...job,
      redispatchCount: job.redispatchCount + 1,
      state: 'queued',
    }
    job.state = 'redispatching'
    this.queue.push(requeued)
    this.pump()
  }

  private async respawn(index: number): Promise<void> {
    const attempts = this.respawnAttempts.get(index) ?? 0
    if (attempts >= RESPAWN_ATTEMPTS || this.isDisposed()) {
      this.respawnAttempts.delete(index)
      return
    }
    this.respawnAttempts.set(index, attempts + 1)
    try {
      const bridge = await this.spawnWorker(index)
      if (this.isDisposed()) {
        bridge.terminate()
        return
      }
      this.bridges[index] = bridge
      this.respawnAttempts.delete(index)
      this.slotAlive[index] = true
      this.available.push(index)
      this.pump()
    } catch {
      this.dispatchEvent({
        type: 'worker-error',
        worker: index,
        message: `worker respawn attempt ${attempts + 1} failed`,
      })
      setTimeout(() => void this.respawn(index), RESPAWN_DELAY_MS * (attempts + 1))
    }
  }

  private settle(job: QueuedJob, fn: () => void): void {
    if (job.state === 'settled') return
    job.state = 'settled'
    fn()
  }

  private pump(): void {
    while (this.queue.length > 0) {
      const runnable = this.available.findIndex((w) =>
        this.queue.some((job) => job.worker === undefined || job.worker === w),
      )
      if (runnable === -1) break
      const idx = this.available.splice(runnable, 1)[0]!
      const jobIdx = this.queue.findIndex((job) => job.worker === undefined || job.worker === idx)
      const job = this.queue.splice(jobIdx, 1)[0]!
      const bridge = this.bridges[idx]
      if (!bridge || !this.slotAlive[idx]) {
        this.available.push(idx)
        continue
      }
      this.inFlight++
      job.state = 'in-flight'
      this.inFlightJobs.set(idx, job)
      bridge
        .request(job.op, job.payload, job.transfer)
        .then((v) => this.settle(job, () => job.resolve(v)))
        .catch((e: unknown) => {
          const err = e instanceof Error ? e : new Error(String(e))
          this.settle(job, () => job.reject(err))
        })
        .finally(() => {
          if (this.inFlightJobs.get(idx) === job) {
            this.inFlight--
            this.inFlightJobs.delete(idx)
            if (this.slotAlive[idx]) {
              this.available.push(idx)
              this.pump()
            }
          }
        })
    }
  }
}
