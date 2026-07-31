export type StorageBackend = 'opfs' | 'indexeddb' | 'auto'

export interface OxelotFile {
  size(): Promise<number>
  readBytes(offset: number, length: number): Promise<Uint8Array>
  writeBytes(offset: number, data: Uint8Array): Promise<void>
  truncate(size: number): Promise<void>
  sync(): Promise<void>
  close(): Promise<void>
}

export interface StorageProvider {
  readonly backend: StorageBackend
  open(name: string, mode: 'read' | 'readwrite'): Promise<OxelotFile>
  remove(name: string): Promise<void>
  entries(): Promise<string[]>
  isSupported(): boolean
}

export interface KvProvider {
  set<T>(key: string, value: T): Promise<void>
  get<T>(key: string): Promise<T | null>
}
