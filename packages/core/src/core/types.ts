import type { SyncState } from './sync/envelope'

export type OxelotEvent =
  | { type: 'storage-change'; key: string; sourceTab: string }
  | { type: 'sync-state'; state: SyncState }
  | { type: 'worker-error'; worker: number; message: string }
  | { type: 'ready' }
  | { type: 'event'; name: string; payload?: unknown }

export interface DatabaseFacade {
  run(sql: string, params?: unknown[]): Promise<void>
  query<T>(sql: string, params?: unknown[]): Promise<T[]>
  exec<T>(sql: string, params?: unknown[]): Promise<T | null>
  checkpoint(): Promise<void>
}
