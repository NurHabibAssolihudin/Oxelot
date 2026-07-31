import type { OxelotFile, StorageProvider } from './types'
import { oxError } from '../../errors'

interface OpfsSyncHandleLike {
  read(buffer: Uint8Array, options?: { at: number }): number
  write(buffer: Uint8Array, options?: { at: number }): number
  truncate(size: number): void
  getSize(): number
  flush(): void
  close(): void
}

export function isWorkerScope(): boolean {
  return typeof self !== 'undefined' && 'postMessage' in self
}

export class OpfsFile implements OxelotFile {
  constructor(
    private readonly name: string,
    private readonly handle: OpfsSyncHandleLike,
  ) {}

  async size(): Promise<number> {
    return this.handle.getSize()
  }

  async readBytes(offset: number, length: number): Promise<Uint8Array> {
    const buf = new Uint8Array(length)
    const n = this.handle.read(buf, { at: offset })
    return buf.slice(0, n)
  }

  async writeBytes(offset: number, data: Uint8Array): Promise<void> {
    this.handle.write(data, { at: offset })
  }

  async truncate(size: number): Promise<void> {
    this.handle.truncate(size)
  }

  async sync(): Promise<void> {
    this.handle.flush()
  }

  async close(): Promise<void> {
    this.handle.flush()
    this.handle.close()
  }
}

interface AsyncIterableDirectory extends FileSystemDirectoryHandle {
  values(): AsyncIterableIterator<FileSystemHandle>
}

export class OpfsStorage implements StorageProvider {
  readonly backend = 'opfs' as const
  private readonly dirPromise: Promise<FileSystemDirectoryHandle>

  constructor() {
    if (!isWorkerScope()) throw oxError('ERR_OPFS_MAIN_THREAD', 'OPFS sync handles are worker-only')
    if (!OpfsStorage.isSupported()) throw oxError('ERR_OPFS_UNSUPPORTED', 'OPFS not available in this context')
    this.dirPromise = navigator.storage.getDirectory()
  }

  static isSupported(): boolean {
    return (
      typeof navigator !== 'undefined' &&
      'storage' in navigator &&
      typeof navigator.storage.getDirectory === 'function'
    )
  }

  async open(name: string, mode: 'read' | 'readwrite'): Promise<OxelotFile> {
    if (mode === 'read') {
      const dir = await this.dirPromise
      const handle = await dir.getFileHandle(name, { create: false })
      return new OpfsFile(name, await handle.createSyncAccessHandle())
    }
    const dir = await this.dirPromise
    const handle = await dir.getFileHandle(name, { create: true })
    return new OpfsFile(name, await handle.createSyncAccessHandle())
  }

  async remove(name: string): Promise<void> {
    const dir = await this.dirPromise
    await dir.removeEntry(name)
  }

  async entries(): Promise<string[]> {
    const dir = (await this.dirPromise) as AsyncIterableDirectory
    const out: string[] = []
    for await (const handle of dir.values()) {
      if (handle.kind === 'file') out.push(handle.name)
    }
    return out
  }

  isSupported(): boolean {
    return OpfsStorage.isSupported()
  }
}
