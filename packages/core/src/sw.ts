import { PersistentSyncQueue, FetchSyncDelivery } from './core/sync'
import type { SyncService } from './core/sync'
import { WorkerKv } from './sw-kv'

export interface SwSyncConfig {
  serverUrl: string
}

export class SwSync {
  private readonly sync: SyncService

  constructor(config: SwSyncConfig) {
    this.sync = new PersistentSyncQueue(
      new WorkerKv(),
      new FetchSyncDelivery({ serverUrl: config.serverUrl }),
    )
  }

  flush(): Promise<{ delivered: number; deadLetters: number }> {
    return this.sync.flush()
  }

  status(): Promise<{ pending: number; deadLetters: number }> {
    return this.sync.status()
  }
}

export const SYNC_TAG = 'oxelot-sync'
