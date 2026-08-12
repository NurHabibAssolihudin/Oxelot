export type DaemonState = 'disconnected' | 'connecting' | 'ready'

/** A transport socket the connection drives (WebSocket, DataChannel, or a test fake). */
export interface DaemonSocket {
  readonly closed: boolean
  send(data: string): void
  close(): void
}

export interface DaemonTransportHandlers {
  onMessage(raw: string): void
  onClose(err?: Error): void
}

/** Opens a single outbound transport attempt (§5.4.2). Must be re-invocable per attempt. */
export interface DaemonTransportFactory {
  /** Diagnostic name, e.g. 'websocket' or 'webrtc-datachannel'. */
  readonly kind: string
  open(url: string, handlers: DaemonTransportHandlers): DaemonSocket
}

export interface DaemonBackoff {
  baseMs: number
  multiplier: number
  maxMs: number
}

export interface DaemonConnectionOptions {
  url: string
  /** Handshake budget per transport attempt (default 2000 ms). */
  connectTimeoutMs?: number
  /** Ping cadence once `ready` (default 15000 ms). */
  heartbeatIntervalMs?: number
  /** How long a beat may go without a pong before it is counted as missed (default 5000 ms). */
  heartbeatTimeoutMs?: number
  /** Missed beats before the connection is reset (default 2). */
  maxMissedBeats?: number
  /** Per-request timeout in ms (default 10000). */
  requestTimeoutMs?: number
  /** Backoff schedule for reconnect cycles (default 500 ms ×2 capped at 30 s). */
  backoff?: DaemonBackoff
  /** Ordered transport factories (default `[websocket, webrtc-datachannel]`, §5.4.2). */
  transports?: DaemonTransportFactory[]
  /** Stable per-session client id sent in `hello`. */
  clientId?: string
}
