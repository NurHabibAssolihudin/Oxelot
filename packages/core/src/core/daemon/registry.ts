import type { OxelotErrorCode } from '../../errors'
import { oxError } from '../../errors'

/**
 * §5.4.6 v1 capability registry (normative home). Descriptors document the
 * request/response shape and the errors each capability may return; they are
 * informational for the wire (the daemon is the source of truth for its own
 * shapes) but drive the typed passthrough surface on `DaemonBridge`.
 */
export interface CapabilityDescriptor {
  /** `domain:action`, e.g. `serial:open`. */
  cap: string
  /** `true` ⇒ `daemon.grant(cap)` (user gesture, session-scoped) before any request. */
  permission: boolean
  /** Human-readable request shape. */
  request?: string
  /** Human-readable response shape. */
  response?: string
  /** §5.6 codes this capability may produce. */
  errors?: readonly OxelotErrorCode[]
}

export const DAEMON_REGISTRY: readonly CapabilityDescriptor[] = [
  {
    cap: 'serial:list',
    permission: false,
    response: '[{ path, vendorId, productId }]',
    errors: ['ERR_DAEMON_UNSUPPORTED'],
  },
  {
    cap: 'serial:open',
    permission: true,
    request: '{ path, baudRate }',
    response: '{ handle }',
    errors: ['ERR_PERMISSION_DENIED', 'ERR_DAEMON_NOT_FOUND'],
  },
  {
    cap: 'serial:read',
    permission: true,
    request: '{ handle, size }',
    response: '{ bytes } (base64)',
    errors: ['ERR_PERMISSION_DENIED'],
  },
  {
    cap: 'serial:write',
    permission: true,
    request: '{ handle, bytes } (base64)',
    response: '{}',
    errors: ['ERR_PERMISSION_DENIED'],
  },
  {
    cap: 'socket:connect',
    permission: true,
    request: '{ host, port }',
    response: '{ handle }',
    errors: ['ERR_PERMISSION_DENIED', 'ERR_SYNC_NETWORK'],
  },
  {
    cap: 'socket:relay',
    permission: true,
    request: '{ handle, bytes } (base64)',
    response: 'event push',
    errors: ['ERR_PERMISSION_DENIED'],
  },
  {
    cap: 'file:watch',
    permission: true,
    request: '{ path }',
    response: 'event push',
    errors: ['ERR_PERMISSION_DENIED', 'ERR_FILE_NOT_FOUND'],
  },
  {
    cap: 'file:get',
    permission: false,
    request: '{ key }',
    response: '<value> | null',
    errors: ['ERR_DAEMON_UNSUPPORTED'],
  },
  {
    cap: 'file:set',
    permission: false,
    request: '{ key, value }',
    response: '{}',
    errors: ['ERR_DAEMON_UNSUPPORTED'],
  },
  {
    cap: 'sys:stats',
    permission: false,
    response: '{ cpu, mem, uptimeMs }',
    errors: ['ERR_DAEMON_UNSUPPORTED'],
  },
]

/** Look up the §5.4.6 descriptor for a capability name. */
export function describeCapability(cap: string): CapabilityDescriptor | undefined {
  return DAEMON_REGISTRY.find((c) => c.cap === cap)
}

/** §5.4.6 typed response shapes for the passthrough surface. */
export interface SerialPortInfo {
  path: string
  vendorId?: string
  productId?: string
}
export interface SerialOpenResult {
  handle: string
}
export interface SerialReadResult {
  bytes: string
}
export interface SocketConnectResult {
  handle: string
}
export interface SystemStats {
  cpu: number
  mem: number
  uptimeMs: number
}

export interface DaemonSerialApi {
  list(): Promise<SerialPortInfo[]>
  open(path: string, baudRate: number): Promise<SerialOpenResult>
  read(handle: string, size: number): Promise<SerialReadResult>
  write(handle: string, bytes: string): Promise<void>
}
export interface DaemonSocketApi {
  connect(host: string, port: number): Promise<SocketConnectResult>
  relay(handle: string, bytes: string): Promise<void>
}
export interface DaemonFileApi {
  watch(path: string): Promise<void>
}
export interface DaemonSysApi {
  stats(): Promise<SystemStats>
}

/**
 * Base64 helpers for the §5.4.6 `bytes` fields. Uses the global `btoa`/`atob`
 * (present in browsers and Node ≥ 16) so the core bundle stays Buffer-free.
 */
export function encodeBytes(bytes: Uint8Array): string {
  const btoa = (globalThis as unknown as { btoa?: (s: string) => string }).btoa
  if (!btoa) throw oxError('ERR_UNKNOWN', 'btoa is unavailable for base64 encoding')
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

export function decodeBytes(base64: string): Uint8Array {
  const atob = (globalThis as unknown as { atob?: (s: string) => string }).atob
  if (!atob) throw oxError('ERR_UNKNOWN', 'atob is unavailable for base64 decoding')
  const binary = atob(base64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}