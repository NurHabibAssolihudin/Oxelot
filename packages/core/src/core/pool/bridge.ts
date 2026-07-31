import { oxError } from '../../errors'

export type OxelotMessage =
  | { kind: 'request'; id: string; op: string; payload?: unknown; transfer?: ArrayBuffer[] }
  | { kind: 'response'; id: string; ok: true; result?: unknown }
  | { kind: 'response'; id: string; ok: false; error: { code: string; message: string } }
  | { kind: 'event'; name: string; payload?: unknown }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class OxelotBridge {
  private readonly pending = new Map<string, Pending>()
  private nextId = 0
  private readonly listeners = new Set<(name: string, payload?: unknown) => void>()
  private readonly timeouts = new Set<ReturnType<typeof setTimeout>>()

  constructor(
    private readonly worker: Worker,
    private readonly timeoutMs = 10_000,
  ) {
    worker.addEventListener('message', (ev: MessageEvent<OxelotMessage>) => {
      const msg = ev.data
      if (msg.kind === 'response') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(oxError(msg.error.code as never, msg.error.message))
      } else if (msg.kind === 'event') {
        for (const cb of this.listeners) cb(msg.name, msg.payload)
      }
    })
  }

  request<T>(op: string, payload?: unknown, transfer?: ArrayBuffer[]): Promise<T> {
    const id = String(this.nextId++)
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.timeouts.delete(timeout)
        if (this.pending.delete(id)) reject(oxError('ERR_BRIDGE_TIMEOUT', `op "${op}" timed out after ${this.timeoutMs}ms`))
      }, this.timeoutMs)
      this.timeouts.add(timeout)
      const wrappedResolve = (v: unknown): void => {
        this.timeouts.delete(timeout)
        clearTimeout(timeout)
        resolve(v as T)
      }
      const wrappedReject = (e: Error): void => {
        this.timeouts.delete(timeout)
        clearTimeout(timeout)
        reject(e)
      }
      this.pending.set(id, { resolve: wrappedResolve, reject: wrappedReject })
      const message: OxelotMessage = { kind: 'request', id, op }
      if (payload !== undefined) message.payload = payload
      if (transfer !== undefined) {
        message.transfer = transfer
        this.worker.postMessage(message, transfer)
      } else {
        this.worker.postMessage(message)
      }
    })
  }

  onEvent(cb: (name: string, payload?: unknown) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  get pendingCount(): number {
    return this.pending.size
  }

  terminate(): void {
    this.dispose()
    this.worker.terminate()
  }

  dispose(): void {
    for (const t of this.timeouts) clearTimeout(t)
    this.timeouts.clear()
    this.pending.clear()
    this.listeners.clear()
  }
}
