import { OxelotError, oxError } from '../../errors'
import type { OxelotErrorCode } from '../../errors'

export const DAEMON_PROTOCOL_VERSION = 1

export interface CapabilityAdvertisement {
  cap: string
  permission: boolean
  schema?: Record<string, unknown>
}

export interface DaemonHello {
  type: 'hello'
  app: 'oxelot'
  protocolVersion: number
  clientId: string
}

export interface DaemonAdvertise {
  type: 'advertise'
  protocolVersion: number
  caps: CapabilityAdvertisement[]
}

export interface DaemonRequest {
  type: 'request'
  protocolVersion: number
  id: string
  cap: string
  data?: unknown
}

export interface DaemonResponseOk {
  type: 'response'
  protocolVersion: number
  id: string
  cap: string
  ok: true
  data?: unknown
}

export interface DaemonResponseError {
  type: 'response'
  protocolVersion: number
  id: string
  cap: string
  ok: false
  error: { code: string; message: string }
}

export type DaemonResponse = DaemonResponseOk | DaemonResponseError

export interface DaemonEvent {
  type: 'event'
  protocolVersion: number
  cap: string
  data?: unknown
}

export interface DaemonPing {
  type: 'ping'
}

export interface DaemonPong {
  type: 'pong'
}

export type DaemonMessage =
  | DaemonHello
  | DaemonAdvertise
  | DaemonRequest
  | DaemonResponse
  | DaemonEvent
  | DaemonPing
  | DaemonPong

const VERSIONED_TYPES = new Set(['hello', 'advertise', 'request', 'response', 'event'])

function schemaError(message: string): OxelotError {
  return oxError('ERR_DAEMON_SCHEMA', message)
}

function asObject(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw schemaError(`${what} must be a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Parse + validate one inbound daemon frame (§5.4.3). Throws
 * `ERR_DAEMON_SCHEMA` on structural violations and `ERR_DAEMON_VERSION` on an
 * unsupported `protocolVersion`.
 */
export function parseDaemonMessage(raw: string): DaemonMessage {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw schemaError('frame is not valid JSON')
  }
  const obj = asObject(parsed, 'frame')
  const type = obj.type
  if (typeof type !== 'string') throw schemaError('frame is missing a string `type`')
  if (VERSIONED_TYPES.has(type) && obj.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
    throw oxError(
      'ERR_DAEMON_VERSION',
      `frame protocolVersion ${String(obj.protocolVersion)} is not supported (this client speaks v${DAEMON_PROTOCOL_VERSION})`,
    )
  }
  switch (type) {
    case 'hello': {
      if (obj.app !== 'oxelot' || typeof obj.clientId !== 'string') throw schemaError('malformed hello')
      return { type: 'hello', app: 'oxelot', protocolVersion: DAEMON_PROTOCOL_VERSION, clientId: obj.clientId }
    }
    case 'advertise': {
      if (!Array.isArray(obj.caps)) throw schemaError('advertise is missing a `caps` array')
      const capsArr = obj.caps as unknown[]
      const caps: CapabilityAdvertisement[] = capsArr.map((item, index) => {
        const cc = asObject(item, `caps[${index}]`)
        if (typeof cc.cap !== 'string' || typeof cc.permission !== 'boolean') {
          throw schemaError(`caps[${index}] must have a string cap and a boolean permission`)
        }
        const adv: CapabilityAdvertisement = { cap: cc.cap, permission: cc.permission }
        if (cc.schema !== undefined) {
          if (typeof cc.schema !== 'object' || cc.schema === null || Array.isArray(cc.schema)) {
            throw schemaError(`caps[${index}].schema must be an object`)
          }
          adv.schema = cc.schema as Record<string, unknown>
        }
        return adv
      })
      return { type: 'advertise', protocolVersion: DAEMON_PROTOCOL_VERSION, caps }
    }
    case 'request': {
      if (typeof obj.id !== 'string' || typeof obj.cap !== 'string') throw schemaError('malformed request')
      const msg: DaemonRequest = { type: 'request', protocolVersion: DAEMON_PROTOCOL_VERSION, id: obj.id, cap: obj.cap }
      if (obj.data !== undefined) msg.data = obj.data
      return msg
    }
    case 'response': {
      if (typeof obj.id !== 'string' || typeof obj.cap !== 'string') throw schemaError('malformed response')
      if (typeof obj.ok !== 'boolean') throw schemaError('response is missing a boolean `ok`')
      if (obj.ok) {
        const msg: DaemonResponseOk = {
          type: 'response',
          protocolVersion: DAEMON_PROTOCOL_VERSION,
          id: obj.id,
          cap: obj.cap,
          ok: true,
        }
        if (obj.data !== undefined) msg.data = obj.data
        return msg
      }
      const err = asObject(obj.error, 'response.error')
      if (typeof err.code !== 'string' || typeof err.message !== 'string') {
        throw schemaError('error response must have string `error.code` and `error.message`')
      }
      return {
        type: 'response',
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        id: obj.id,
        cap: obj.cap,
        ok: false,
        error: { code: err.code, message: err.message },
      }
    }
    case 'event': {
      if (typeof obj.cap !== 'string') throw schemaError('malformed event')
      const msg: DaemonEvent = { type: 'event', protocolVersion: DAEMON_PROTOCOL_VERSION, cap: obj.cap }
      if (obj.data !== undefined) msg.data = obj.data
      return msg
    }
    case 'ping':
      return { type: 'ping' }
    case 'pong':
      return { type: 'pong' }
    default:
      throw schemaError(`unknown frame type ${JSON.stringify(type)}`)
  }
}

/** Map a daemon-supplied error code onto the §5.6 set; unknown codes degrade to `ERR_UNKNOWN`. */
export function toDaemonErrorCode(code: string): OxelotErrorCode {
  return KNOWN_DAEMON_CODES.has(code) ? (code as OxelotErrorCode) : 'ERR_UNKNOWN'
}

const KNOWN_DAEMON_CODES: ReadonlySet<string> = new Set([
  'ERR_PERMISSION_DENIED',
  'ERR_DAEMON_CONNECT',
  'ERR_DAEMON_TIMEOUT',
  'ERR_DAEMON_SCHEMA',
  'ERR_DAEMON_VERSION',
  'ERR_DAEMON_UNSUPPORTED',
  'ERR_DAEMON_NOT_FOUND',
  'ERR_FILE_NOT_FOUND',
  'ERR_SYNC_NETWORK',
])
