import type { OxelotFile, StorageProvider } from './types'
import { oxError } from '../../errors'

const CHUNK_SIZE = 1024 * 1024 // 1 MiB
const DB_NAME = 'oxelot'
const DB_VERSION = 1
const FILE_STORE = 'files'
const KEY_STORE = 'kv'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(FILE_STORE)) {
        db.createObjectStore(FILE_STORE, { keyPath: 'name' })
      }
      if (!db.objectStoreNames.contains(KEY_STORE)) {
        db.createObjectStore(KEY_STORE, { keyPath: 'key' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(oxError('ERR_UNKNOWN', 'failed to open IndexedDB', req.error))
  })
}

function tx<T>(db: IDBDatabase, store: string, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = db.transaction(store, mode)
    const req = fn(t.objectStore(store))
    req.onsuccess = () => resolve(req.result as T)
    req.onerror = () => reject(oxError('ERR_UNKNOWN', `IDB ${store} request failed`, req.error))
  })
}

interface StoredFile {
  name: string
  chunks: Uint8Array[]
  size: number
}

export class IdbFile implements OxelotFile {
  constructor(
    private readonly db: IDBDatabase,
    private readonly name: string,
  ) {}

  async read(): Promise<StoredFile> {
    const row = await tx<StoredFile | undefined>(this.db, FILE_STORE, 'readonly', (s) =>
      s.get(this.name),
    )
    if (!row) throw oxError('ERR_FILE_NOT_FOUND', `file "${this.name}" not found`)
    return row
  }

  async size(): Promise<number> {
    const row = await this.read()
    return row.size
  }

  async readBytes(offset: number, length: number): Promise<Uint8Array> {
    const row = await this.read()
    const out = new Uint8Array(length)
    let written = 0
    let cursor = offset
    for (const chunk of row.chunks) {
      if (cursor >= chunk.length) {
        cursor -= chunk.length
        continue
      }
      const take = Math.min(chunk.length - cursor, length - written)
      out.set(chunk.subarray(cursor, cursor + take), written)
      written += take
      cursor = 0
      if (written >= length) break
    }
    return out.slice(0, written)
  }

  async writeBytes(offset: number, data: Uint8Array): Promise<void> {
    const fallback: StoredFile = { name: this.name, chunks: [], size: 0 }
    const row = await this.read().catch(() => fallback)
    // Merge into chunk list (simplified: rewrite affected chunks).
    const chunkCount = Math.ceil((offset + data.length) / CHUNK_SIZE)
    while (row.chunks.length < chunkCount) row.chunks.push(new Uint8Array(0))
    const chunkIdx = Math.floor(offset / CHUNK_SIZE)
    const within = offset % CHUNK_SIZE
    const merged = new Uint8Array(CHUNK_SIZE)
    const existing = row.chunks[chunkIdx] ?? new Uint8Array(0)
    merged.set(existing.subarray(0, within))
    merged.set(data.subarray(0, Math.min(data.length, CHUNK_SIZE - within)), within)
    row.chunks[chunkIdx] = merged
    // Remaining chunks untouched. Update size.
    const end = offset + data.length
    row.size = Math.max(row.size, end)
    await tx(this.db, FILE_STORE, 'readwrite', (s) => s.put(row))
  }

  async truncate(size: number): Promise<void> {
    const fallback: StoredFile = { name: this.name, chunks: [], size: 0 }
    const row = await this.read().catch(() => fallback)
    row.size = size
    const needed = Math.ceil(size / CHUNK_SIZE)
    row.chunks = row.chunks.slice(0, needed)
    if (needed > 0) {
      const lastIdx = needed - 1
      const last = row.chunks[lastIdx] ?? new Uint8Array(0)
      const remain = size - lastIdx * CHUNK_SIZE
      row.chunks[lastIdx] = last.slice(0, remain)
    }
    await tx(this.db, FILE_STORE, 'readwrite', (s) => s.put(row))
  }

  async sync(): Promise<void> {
    // IndexedDB writes are already transactional; nothing to flush.
  }

  async close(): Promise<void> {
    // No-op; rows already persisted.
  }
}

export class IdbStorage implements StorageProvider {
  readonly backend = 'indexeddb' as const
  private dbPromise: Promise<IDBDatabase> | null = null

  private db(): Promise<IDBDatabase> {
    if (!this.dbPromise) this.dbPromise = openDb()
    return this.dbPromise
  }

  static isSupported(): boolean {
    return typeof indexedDB !== 'undefined'
  }

  async open(name: string, mode: 'read' | 'readwrite'): Promise<OxelotFile> {
    void mode
    return new IdbFile(await this.db(), name)
  }

  async remove(name: string): Promise<void> {
    const db = await this.db()
    await tx(db, FILE_STORE, 'readwrite', (s) => s.delete(name))
  }

  async entries(): Promise<string[]> {
    const db = await this.db()
    const rows = await tx<StoredFile[]>(db, FILE_STORE, 'readonly', (s) => s.getAll())
    return rows.map((r) => r.name)
  }

  async set<T>(key: string, value: T): Promise<void> {
    const db = await this.db()
    await tx(db, KEY_STORE, 'readwrite', (s) => s.put({ key, value }))
  }

  async get<T>(key: string): Promise<T | null> {
    const db = await this.db()
    const row = await tx<{ key: string; value: T } | undefined>(db, KEY_STORE, 'readonly', (s) => s.get(key))
    return row?.value ?? null
  }

  isSupported(): boolean {
    return IdbStorage.isSupported()
  }
}
