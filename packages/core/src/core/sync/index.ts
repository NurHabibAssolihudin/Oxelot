export { PersistentSyncQueue, FetchSyncDelivery, SYNC_TAG } from './queue'
export type { SyncService, SyncDelivery, KvLike, SyncLock } from './queue'
export { serializeMutation, deserializeMutation } from './envelope'
export type { OxelotMutation, SyncState } from './envelope'
export { nextRetryDelayMs, isDeadLetter } from './scheduler'
export { WebLock } from './web-lock'
export {
  PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS,
  detectSyncCapabilities,
  registerPeriodicSync,
} from './capabilities'
export type { SyncCapabilities, PeriodicSyncOptions, PeriodicSyncResult } from './capabilities'
