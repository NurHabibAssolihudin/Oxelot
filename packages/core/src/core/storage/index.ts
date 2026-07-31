import type { StorageBackend, StorageProvider, OxelotFile } from './types'
import { OpfsStorage, isWorkerScope } from './opfs'
import { IdbStorage } from './idb'

export type { StorageBackend, StorageProvider, OxelotFile } from './types'

export interface WorkerStorageFacade extends StorageProvider {
  set<T>(key: string, value: T): Promise<void>
  get<T>(key: string): Promise<T | null>
}

export function selectBackend(preference: StorageBackend): StorageProvider {
  if (preference === 'opfs') return new OpfsStorage()
  if (preference === 'indexeddb') return new IdbStorage()
  return isWorkerScope() && OpfsStorage.isSupported() ? new OpfsStorage() : new IdbStorage()
}

/**
 * Creates the worker-side storage facade. File I/O goes through the selected
 * backend; structured KV always goes through IndexedDB (available everywhere).
 */
export function createWorkerStorage(): Promise<WorkerStorageFacade> {
  const fileProvider = selectBackend('auto')
  const kv = new IdbStorage()
  return Promise.resolve({
    backend: fileProvider.backend,
    open: (name: string, mode: 'read' | 'readwrite'): Promise<OxelotFile> => fileProvider.open(name, mode),
    remove: (name: string) => fileProvider.remove(name),
    entries: () => fileProvider.entries(),
    isSupported: () => fileProvider.isSupported(),
    set: <T>(key: string, value: T) => kv.set(key, value),
    get: <T>(key: string) => kv.get<T>(key),
  })
}

export { OpfsStorage, OpfsFile, isWorkerScope } from './opfs'
export { IdbStorage, IdbFile } from './idb'
