export type OxelotErrorCode =
  | 'ERR_OPFS_MAIN_THREAD'
  | 'ERR_OPFS_UNSUPPORTED'
  | 'ERR_FILE_NOT_FOUND'
  | 'ERR_QUOTA_EXCEEDED'
  | 'ERR_WORKER_SPAWN'
  | 'ERR_BRIDGE_TIMEOUT'
  | 'ERR_HW_DENIED'
  | 'ERR_HW_UNSUPPORTED'
  | 'ERR_HW_GESTURE_REQUIRED'
  | 'ERR_SYNC_NETWORK'
  | 'ERR_SYNC_REJECTED'
  | 'ERR_DB_DISABLED'
  | 'ERR_DB_SQL'
  | 'ERR_PERMISSION_DENIED'
  | 'ERR_DAEMON_CONNECT'
  | 'ERR_DAEMON_TIMEOUT'
  | 'ERR_DAEMON_SCHEMA'
  | 'ERR_DAEMON_VERSION'
  | 'ERR_DAEMON_UNSUPPORTED'
  | 'ERR_DAEMON_NOT_FOUND'
  | 'ERR_UNKNOWN'

export class OxelotError extends Error {
  readonly code: OxelotErrorCode
  override readonly cause?: unknown

  constructor(code: OxelotErrorCode, message: string, cause?: unknown) {
    super(message)
    this.name = 'OxelotError'
    this.code = code
    this.cause = cause
  }
}

export function oxError(code: OxelotErrorCode, message: string, cause?: unknown): OxelotError {
  return new OxelotError(code, message, cause)
}

export function toOxelotError(err: unknown): OxelotError {
  if (err instanceof OxelotError) return err
  if (err instanceof Error) return oxError('ERR_UNKNOWN', err.message, err)
  return oxError('ERR_UNKNOWN', String(err))
}
