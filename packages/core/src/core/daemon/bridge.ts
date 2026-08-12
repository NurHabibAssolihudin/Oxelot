import { DaemonConnection } from './connection'
import type { DaemonConnectionOptions } from './types'
import type { DaemonState } from './types'
import { GrantGate } from './grant'
import type { GestureSource } from './grant'
import type { CapabilityAdvertisement } from './schema'
import type {
  DaemonFileApi,
  DaemonSerialApi,
  DaemonSocketApi,
  DaemonSysApi,
  SerialPortInfo,
  SerialOpenResult,
  SerialReadResult,
  SocketConnectResult,
  SystemStats,
} from './registry'
import { oxError } from '../../errors'

export interface DaemonBridgeOptions {
  /** Daemon URL, e.g. `ws://127.0.0.1:9090` (§5.4.2). */
  url: string
  /** Connection tuning (§5.4.4); `url` is taken from the bridge options. */
  connection?: Omit<DaemonConnectionOptions, 'url'>
  /** Gesture detector for `grant(cap)` (M3.3); defaults to `navigator.userActivation.isActive`. */
  gestureSource?: GestureSource
}

/**
 * M3.2/M3.3 daemon bridge (§5.4). Owns one connection, enforces the
 * session-scoped permission gate (`grant(cap)`, user gesture required),
 * and exposes the §5.4.6 typed passthrough surface (`serial`, `socket`,
 * `file`, `sys`). The `file:get`/`file:set` caps back the M3.2 storage
 * handoff (`fileGet`/`fileSet`).
 */
export class DaemonBridge {
  private readonly connection: DaemonConnection
  private readonly gate: GrantGate
  private readonly advertisedCaps = new Map<string, CapabilityAdvertisement>()
  private readonly proxies = new Map<string, (data?: unknown) => Promise<unknown>>()
  private readonly eventHandlers = new Map<string, Set<(data: unknown) => void>>()
  private disposed = false

  readonly serial: DaemonSerialApi
  readonly socket: DaemonSocketApi
  readonly file: DaemonFileApi
  readonly sys: DaemonSysApi

  constructor(opts: DaemonBridgeOptions) {
    this.connection = new DaemonConnection({ url: opts.url, ...opts.connection })
    this.gate = new GrantGate(opts.gestureSource === undefined ? {} : { gestureSource: opts.gestureSource })
    this.connection.onEvent((cap, data) => this.dispatchEvent(cap, data))
    this.connection.onStateChange((state) => {
      if (state === 'ready') {
        this.advertisedCaps.clear()
        for (const adv of this.connection.advertisements()) this.advertisedCaps.set(adv.cap, adv)
      } else {
        // No stale advertisements may survive a disconnect (§5.4.4).
        this.advertisedCaps.clear()
      }
    })
    this.serial = {
      list: () => this.request<SerialPortInfo[]>('serial:list'),
      open: (path, baudRate) => this.request<SerialOpenResult>('serial:open', { path, baudRate }),
      read: (handle, size) => this.request<SerialReadResult>('serial:read', { handle, size }),
      write: (handle, bytes) => this.request('serial:write', { handle, bytes }).then(() => undefined),
    }
    this.socket = {
      connect: (host, port) => this.request<SocketConnectResult>('socket:connect', { host, port }),
      relay: (handle, bytes) => this.request('socket:relay', { handle, bytes }).then(() => undefined),
    }
    this.file = {
      watch: (path) => this.request('file:watch', { path }).then(() => undefined),
    }
    this.sys = {
      stats: () => this.request<SystemStats>('sys:stats'),
    }
  }

  get state(): DaemonState {
    return this.connection.state
  }

  onStateChange(cb: (state: DaemonState) => void): () => void {
    return this.connection.onStateChange(cb)
  }

  /** True when the daemon currently advertises the capability (§5.4.3). */
  has(cap: string): boolean {
    return this.advertisedCaps.has(cap)
  }

  /** Advertised capabilities with their permission flags (§5.4.3). */
  capabilities(): CapabilityAdvertisement[] {
    return [...this.advertisedCaps.values()].map((adv) => ({ ...adv }))
  }

  /** True when the daemon requires a session `grant` before requests to `cap` (M3.3). */
  requiresGrant(cap: string): boolean {
    return this.advertisedCaps.get(cap)?.permission ?? false
  }

  /**
   * Grant `cap` for this session (M3.3, §5.4.5 point 4). Requires an active user
   * gesture (`ERR_PERMISSION_DENIED` otherwise); no-op for `permission: false`
   * capabilities; rejects `ERR_DAEMON_UNSUPPORTED` for unadvertised caps.
   */
  grant(cap: string): void {
    if (this.disposed) throw oxError('ERR_DAEMON_CONNECT', 'daemon bridge is disposed')
    const adv = this.advertisedCaps.get(cap)
    if (!adv) {
      throw oxError('ERR_DAEMON_UNSUPPORTED', `daemon does not advertise capability ${JSON.stringify(cap)}`)
    }
    if (adv.permission) this.gate.grant(cap)
  }

  /** True when `cap` was granted this session (or needs no grant). */
  isGranted(cap: string): boolean {
    const adv = this.advertisedCaps.get(cap)
    return adv === undefined ? false : adv.permission ? this.gate.isGranted(cap) : true
  }

  /**
   * Capability RPC (§5.4.3). Rejects `ERR_DAEMON_CONNECT` when the connection is
   * not `ready`, `ERR_DAEMON_UNSUPPORTED` when the daemon does not advertise
   * `cap`, `ERR_PERMISSION_DENIED` when `cap` requires an un-granted permission,
   * `ERR_DAEMON_TIMEOUT` on request timeout, and the daemon's own error code for
   * capability failures.
   */
  async request<T = unknown>(cap: string, data?: unknown): Promise<T> {
    if (this.disposed) throw oxError('ERR_DAEMON_CONNECT', 'daemon bridge is disposed')
    const adv = this.advertisedCaps.get(cap)
    if (!adv) {
      throw oxError('ERR_DAEMON_UNSUPPORTED', `daemon does not advertise capability ${JSON.stringify(cap)}`)
    }
    if (adv.permission && !this.gate.isGranted(cap)) {
      throw oxError('ERR_PERMISSION_DENIED', `capability ${JSON.stringify(cap)} requires daemon.grant(cap) (user gesture)`)
    }
    return (await this.connection.request(cap, data)) as T
  }

  /** Subscribe to daemon-pushed events for a capability. Returns an unsubscribe. */
  onEvent(cap: string, cb: (data: unknown) => void): () => void {
    let set = this.eventHandlers.get(cap)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(cap, set)
    }
    set.add(cb)
    return () => set.delete(cb)
  }

  /** Define a local capability proxy (§5.5): invokes `impl` on inbound `request` frames. */
  onRequest<T = unknown>(cap: string, impl: (data?: T) => Promise<unknown> | unknown): void {
    this.proxies.set(cap, async (data?: unknown) => impl(data as T))
  }

  /** Host a capability proxy's reply (§5.5) — the peer side of `onRequest`. */
  async proxyRequest<T = unknown>(cap: string, data?: unknown): Promise<T> {
    if (this.disposed) throw oxError('ERR_DAEMON_CONNECT', 'daemon bridge is disposed')
    const impl = this.proxies.get(cap)
    if (!impl) {
      throw oxError('ERR_DAEMON_NOT_FOUND', `no local capability implementation for ${JSON.stringify(cap)}`)
    }
    return (await impl(data)) as T
  }

  /**
   * Storage pass-through via the daemon (M3.2, §5.4.6 `file:get`/`file:set`).
   * Requires the daemon to advertise `file:get`/`file:set`; otherwise rejects
   * `ERR_DAEMON_UNSUPPORTED` and the default in-process storage stays active.
   */
  async fileGet<T = unknown>(key: string): Promise<T | null> {
    return this.request<T | null>('file:get', { key })
  }

  async fileSet<T = unknown>(key: string, value: T): Promise<void> {
    await this.request('file:set', { key, value })
  }

  /** Connect on first use; resolves when `ready`. Safe to call repeatedly. */
  connect(): Promise<void> {
    return this.connection.connect()
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true
    this.gate.revokeAll()
    this.proxies.clear()
    this.eventHandlers.clear()
    await this.connection.dispose()
  }

  private dispatchEvent(cap: string, data: unknown): void {
    const handlers = this.eventHandlers.get(cap)
    if (!handlers) return
    for (const cb of handlers) {
      try {
        cb(data)
      } catch {
        // a subscriber's exception must not tear down the event dispatch
      }
    }
  }
}