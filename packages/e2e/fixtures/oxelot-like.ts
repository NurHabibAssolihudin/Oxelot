/** Minimal facade shape exercised by e2e fixtures. */
export interface OxelotLike {
  pool: { request(op: string, payload?: unknown): Promise<unknown> }
  storage: {
    readonly backend: string
    get<T>(key: string): Promise<T | null>
    set<T>(key: string, value: T): Promise<void>
    remove(name: string): Promise<void>
    open(
      name: string,
      mode?: string,
    ): Promise<{
      size(): Promise<number>
      readBytes(offset: number, length: number): Promise<Uint8Array>
      writeBytes(offset: number, data: Uint8Array): Promise<void>
      truncate(size: number): Promise<void>
      sync(): Promise<void>
      close(): Promise<void>
    }>
    entries(): Promise<string[]>
  }
  db: {
    run(sql: string, params?: unknown[]): Promise<void>
    query<T>(sql: string, params?: unknown[]): Promise<T[]>
    checkpoint(): Promise<void>
  }
  on(cb: (ev: { type: string; key?: string; sourceTab?: string }) => void): () => void
  dispose(): Promise<void>
}

export interface TestWindow extends Window {
  __oxelot?: { Oxelot: { init(cfg: { workers: number; dbName?: string }): Promise<OxelotLike> } }
}
