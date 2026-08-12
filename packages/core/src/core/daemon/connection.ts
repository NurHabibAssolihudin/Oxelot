import { OxelotError, oxError } from '../../errors'
import { DAEMON_PROTOCOL_VERSION, toDaemonErrorCode } from './schema'
import type { CapabilityAdvertisement, DaemonAdvertise, DaemonMessage, DaemonResponse } from './schema'
import { parseDaemonMessage } from './schema'
import { rtcFactory, wsFactory } from './transport'
import type { DaemonBackoff, DaemonConnectionOptions, DaemonSocket, DaemonState, DaemonTransportFactory } from './types'

/** §5.4.5.1: only these hosts are permitted for the daemon URL. */
const LOCAL_DAEMON_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * §5.4.5.1/5.4.2: refuse any daemon URL that is not a localhost host before any
 * transport is opened, even if the consumer misconfigured the URL.
 */
function assertLocalDaemonUrl(url: string): void {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw oxError('ERR_DAEMON_CONNECT', `invalid daemon URL ${JSON.stringify(url)}`)
  }
  if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
    throw oxError('ERR_DAEMON_CONNECT', `daemon URL must use ws:// or wss:// (got ${parsed.protocol})`)
  }
  if (!LOCAL_DAEMON_HOSTS.has(parsed.hostname)) {
    throw oxError('ERR_DAEMON_CONNECT', `daemon URL host ${JSON.stringify(parsed.hostname)} is not localhost (§5.4.5)`)
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 2_000
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 5_000
const DEFAULT_MAX_MISSED_BEATS = 2
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000
const DEFAULT_BACKOFF: DaemonBackoff = { baseMs: 500, multiplier: 2, maxMs: 30_000 }
const DEFAULT_TRANSPORTS: DaemonTransportFactory[] = [wsFactory, rtcFactory]

/** §5.4.4 backoff schedule: `base * multiplier^attempt`, capped at `max`. */
export function nextBackoffDelay(attempt: number, backoff: DaemonBackoff = DEFAULT_BACKOFF): number {
  const delay = backoff.baseMs * Math.pow(backoff.multiplier, Math.max(attempt, 0))
  return Math.min(delay, backoff.maxMs)
}

function defaultClientId(): string {
  const globalScope = globalThis as unknown as { crypto?: { randomUUID?: () => string } }
  try {
    const c = globalScope.crypto
    if (c?.randomUUID) return c.randomUUID()
  } catch {
    // some embeddings expose crypto without a working randomUUID; fall through
  }
  return `oxelot-${Math.random().toString(36).slice(2)}`
}

interface PendingRequest {
  resolve(value: unknown): void
  reject(err: Error): void
  timer: ReturnType<typeof setTimeout>
}

/**
 * Daemon bridge client connection (§5.4.4 state machine, M3.2). Owns transport
 * attempts, the hello/advertise handshake, heartbeat liveness, reconnect backoff
 * and request/response correlation. Additive: absent transports simply keep the
 * state machine `disconnected` and capability calls reject `ERR_DAEMON_CONNECT`.
 */
export class DaemonConnection {
  private readonly url: string
  private readonly connectTimeoutMs: number
  private readonly heartbeatIntervalMs: number
  private readonly heartbeatTimeoutMs: number
  private readonly maxMissedBeats: number
  private readonly requestTimeoutMs: number
  private readonly backoff: DaemonBackoff
  private readonly transports: DaemonTransportFactory[]
  private readonly clientId: string

  private stateValue: DaemonState = 'disconnected'
  private socket: DaemonSocket | null = null
  private socketGeneration = 0
  private transportIndex = 0
  private attempt = 0
  private disposed = false
  private readonly capsValue: CapabilityAdvertisement[] = []
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null
  private pingTimer: ReturnType<typeof setTimeout> | null = null
  private pongTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private missedBeats = 0
  private requestCounter = 0
  private readonly pending = new Map<string, PendingRequest>()
  private readonly stateListeners = new Set<(state: DaemonState) => void>()
  private readonly eventListeners = new Set<(cap: string, data: unknown) => void>()
  private readonly readyResolvers: Array<() => void> = []
  private readonly readyRejecters: Array<(err: Error) => void> = []

  constructor(opts: DaemonConnectionOptions) {
    assertLocalDaemonUrl(opts.url)
    this.url = opts.url
    this.connectTimeoutMs = opts.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS
    this.heartbeatTimeoutMs = opts.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS
    this.maxMissedBeats = opts.maxMissedBeats ?? DEFAULT_MAX_MISSED_BEATS
    this.requestTimeoutMs = opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    this.backoff = opts.backoff ?? DEFAULT_BACKOFF
    this.transports = opts.transports ?? DEFAULT_TRANSPORTS
    this.clientId = opts.clientId ?? defaultClientId()
  }

  get state(): DaemonState {
    return this.stateValue
  }

  caps(): string[] {
    return this.capsValue.map((c) => c.cap)
  }

  /** Advertised capabilities with their permission flags (§5.4.3). */
  advertisements(): CapabilityAdvertisement[] {
    return this.capsValue.map((c) => ({ ...c }))
  }

  onStateChange(cb: (state: DaemonState) => void): () => void {
    this.stateListeners.add(cb)
    return () => this.stateListeners.delete(cb)
  }

  /** Subscribe to daemon-initiated capability pushes (`event` frames, §5.4.3). */
  onEvent(cb: (cap: string, data: unknown) => void): () => void {
    this.eventListeners.add(cb)
    return () => this.eventListeners.delete(cb)
  }

  /**
   * Start the connect cycle. Resolves once `ready`; rejects `ERR_DAEMON_CONNECT`
   * only when the bridge is disposed. Background retry continues on failure
   * (§5.4.4) and capability calls reject `ERR_DAEMON_CONNECT` until `ready`.
   */
  connect(): Promise<void> {
    if (this.disposed) return Promise.reject(oxError('ERR_DAEMON_CONNECT', 'daemon bridge is disposed'))
    if (this.stateValue === 'ready') return Promise.resolve()
    return new Promise<void>((resolve, reject) => {
      this.readyResolvers.push(resolve)
      this.readyRejecters.push(reject)
      this.startCycle()
    })
  }

  /** Capability RPC (§5.4.3). Rejects `ERR_DAEMON_CONNECT` when not `ready`; never queues. */
  request(cap: string, data?: unknown): Promise<unknown> {
    if (this.disposed) return Promise.reject(oxError('ERR_DAEMON_CONNECT', 'daemon bridge is disposed'))
    if (this.stateValue !== 'ready' || !this.socket) {
      return Promise.reject(oxError('ERR_DAEMON_CONNECT', `daemon not ready (state=${this.stateValue})`))
    }
    this.requestCounter += 1
    const id = `r${this.requestCounter}-${Math.random().toString(36).slice(2)}`
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(oxError('ERR_DAEMON_TIMEOUT', `daemon request ${cap} timed out`))
      }, this.requestTimeoutMs)
      this.pending.set(id, { resolve, reject, timer })
      const frame = { type: 'request', protocolVersion: DAEMON_PROTOCOL_VERSION, id, cap }
      this.socket?.send(JSON.stringify(data === undefined ? frame : { ...frame, data }))
    })
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    if (this.retryTimer !== null) {
      clearTimeout(this.retryTimer)
      this.retryTimer = null
    }
    this.teardownSocket()
    this.setState('disconnected')
    this.rejectReady(oxError('ERR_DAEMON_CONNECT', 'daemon bridge disposed'))
    this.rejectPending(oxError('ERR_DAEMON_CONNECT', 'daemon bridge disposed'))
    this.stateListeners.clear()
    this.eventListeners.clear()
  }

  // ---- cycle: disconnected → connecting → ready (or backoff retry) ----

  private startCycle(): void {
    if (this.disposed || this.retryTimer !== null) return
    if (this.stateValue === 'connecting' || this.stateValue === 'ready') return
    this.setState('connecting')
    this.attemptTransport(0)
  }

  private attemptTransport(index: number): void {
    if (this.disposed) return
    this.transportIndex = index
    const factory = this.transports[index]
    if (!factory) {
      this.disconnectAndRetry(oxError('ERR_DAEMON_CONNECT', 'no daemon transport could connect'))
      return
    }
    this.teardownSocket()
    const generation = ++this.socketGeneration
    let socket: DaemonSocket
    try {
      socket = factory.open(this.url, {
        onMessage: (raw) => this.onMessage(raw, generation),
        onClose: (err) => this.onSocketClose(err, generation),
      })
    } catch (err) {
      this.transportFailed(
        index,
        err instanceof OxelotError ? err : oxError('ERR_DAEMON_CONNECT', 'daemon transport failed to open', err),
      )
      return
    }
    this.socket = socket
    this.handshakeTimer = setTimeout(() => {
      if (this.disposed || this.socketGeneration !== generation) return
      this.transportFailed(index, oxError('ERR_DAEMON_TIMEOUT', 'daemon handshake timed out'))
    }, this.connectTimeoutMs)
    try {
      socket.send(JSON.stringify({ type: 'hello', app: 'oxelot', protocolVersion: DAEMON_PROTOCOL_VERSION, clientId: this.clientId }))
    } catch (err) {
      this.transportFailed(index, oxError('ERR_DAEMON_CONNECT', 'daemon hello send failed', err))
    }
  }

  private transportFailed(index: number, err: Error): void {
    if (this.disposed) return
    if (index + 1 < this.transports.length) {
      this.attemptTransport(index + 1)
      return
    }
    this.disconnectAndRetry(err)
  }

  private disconnectAndRetry(err: Error): void {
    if (this.disposed) return
    this.teardownSocket()
    this.setState('disconnected')
    // Stale advertised caps must not survive a disconnect (§5.4.4).
    this.capsValue.length = 0
    this.rejectPending(oxError('ERR_DAEMON_CONNECT', 'daemon disconnected', err))
    this.scheduleRetry()
  }

  private scheduleRetry(): void {
    if (this.disposed || this.retryTimer !== null) return
    const delay = nextBackoffDelay(this.attempt, this.backoff)
    this.attempt += 1
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (this.disposed) return
      this.startCycle()
    }, delay)
  }

  // ---- inbound frames ----

  private onMessage(raw: string, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return
    let msg: DaemonMessage
    try {
      msg = parseDaemonMessage(raw)
    } catch (err) {
      this.disconnectAndRetry(err instanceof OxelotError ? err : oxError('ERR_DAEMON_SCHEMA', 'frame rejected', err))
      return
    }
    switch (msg.type) {
      case 'advertise':
        if (this.stateValue === 'connecting') this.onAdvertise(msg)
        else this.disconnectAndRetry(oxError('ERR_DAEMON_SCHEMA', 'advertise received outside the handshake'))
        break
      case 'pong':
        this.onPong()
        break
      case 'response':
        this.onResponse(msg)
        break
      case 'event':
        for (const cb of this.eventListeners) cb(msg.cap, msg.data)
        break
      case 'hello':
      case 'request':
      case 'ping':
        // A well-behaved daemon never sends these; treat as schema violations.
        this.disconnectAndRetry(oxError('ERR_DAEMON_SCHEMA', `unexpected frame type from daemon: ${msg.type}`))
        break
    }
  }

  private onAdvertise(adv: DaemonAdvertise): void {
    this.clearHandshakeTimer()
    this.capsValue.length = 0
    for (const c of adv.caps) this.capsValue.push(c)
    this.attempt = 0 // backoff resets on ready (§5.4.4)
    this.missedBeats = 0
    this.setState('ready')
    this.startHeartbeat()
    this.resolveReady()
  }

  private onResponse(msg: DaemonResponse): void {
    const pending = this.pending.get(msg.id)
    if (!pending) {
      // §5.4.3: a response with an unknown id is a schema violation → reset.
      this.disconnectAndRetry(oxError('ERR_DAEMON_SCHEMA', `response with unknown id ${JSON.stringify(msg.id)}`))
      return
    }
    clearTimeout(pending.timer)
    this.pending.delete(msg.id)
    if (msg.ok) pending.resolve(msg.data)
    else pending.reject(oxError(toDaemonErrorCode(msg.error.code), msg.error.message))
  }

  // ---- heartbeat (§5.4.2) ----

  private startHeartbeat(): void {
    this.clearPongTimer()
    this.missedBeats = 0
    this.pingTimer = setInterval(() => {
      if (this.disposed || this.stateValue !== 'ready' || !this.socket) return
      this.socket.send(JSON.stringify({ type: 'ping' }))
      this.pongTimer = setTimeout(() => {
        this.pongTimer = null
        this.missedBeats += 1
        if (this.missedBeats >= this.maxMissedBeats) {
          this.disconnectAndRetry(oxError('ERR_DAEMON_CONNECT', 'daemon heartbeat lost'))
        }
      }, this.heartbeatTimeoutMs)
    }, this.heartbeatIntervalMs)
  }

  private onPong(): void {
    this.missedBeats = 0
    this.clearPongTimer()
  }

  // ---- teardown + hygiene ----

  private teardownSocket(): void {
    this.socketGeneration += 1
    const socket = this.socket
    this.socket = null
    this.clearHandshakeTimer()
    this.clearPongTimer()
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer)
      this.pingTimer = null
    }
    if (socket && !socket.closed) {
      try {
        socket.close()
      } catch {
        // closing a transport must never break state transitions
      }
    }
  }

  private onSocketClose(err: Error | undefined, generation: number): void {
    if (this.disposed || this.socketGeneration !== generation) return
    const closeErr = err instanceof Error ? err : new Error('daemon connection closed')
    if (this.stateValue === 'ready') {
      this.disconnectAndRetry(oxError('ERR_DAEMON_CONNECT', 'daemon connection closed', closeErr))
      return
    }
    this.transportFailed(this.transportIndex, oxError('ERR_DAEMON_CONNECT', 'daemon connection closed during handshake', closeErr))
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer)
      this.handshakeTimer = null
    }
  }

  private clearPongTimer(): void {
    if (this.pongTimer !== null) {
      clearTimeout(this.pongTimer)
      this.pongTimer = null
    }
  }

  private setState(state: DaemonState): void {
    if (this.stateValue === state) return
    this.stateValue = state
    for (const cb of this.stateListeners) cb(state)
  }

  private resolveReady(): void {
    const resolvers = this.readyResolvers.splice(0)
    this.readyRejecters.length = 0
    for (const resolve of resolvers) resolve()
  }

  private rejectReady(err: Error): void {
    const rejecters = this.readyRejecters.splice(0)
    this.readyResolvers.length = 0
    for (const reject of rejecters) reject(err)
  }

  private rejectPending(err: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(err)
    }
    this.pending.clear()
  }
}