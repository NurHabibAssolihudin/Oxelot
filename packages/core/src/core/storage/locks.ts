import { WebLock } from '../sync/web-lock'

export function storageLockName(name: string): string {
  return `oxelot-storage:${name}`
}

export interface StorageGuard {
  readonly isSupported: boolean
  /**
   * Run `fn` while holding the exclusive `oxelot-storage:<name>` Web Lock for
   * this origin. Writes go through the lock so concurrent writers in any realm
   * (worker, service worker, sibling tab) serialize — the shared queue and the
   * DB image file are single-writer. Reads go through the same exclusive lock
   * so a reader can never observe a partially-written value. No-op (fn runs
   * directly) where Web Locks are unavailable (Node, non-supporting engines).
   */
  withLock<T>(name: string, fn: () => Promise<T>): Promise<T>
}

export function createStorageGuard(locks?: LockManager): StorageGuard {
  const webLock = new WebLock(locks)
  return {
    isSupported: webLock.isSupported,
    withLock: <T>(name: string, fn: () => Promise<T>) => webLock.withLock(storageLockName(name), fn),
  }
}