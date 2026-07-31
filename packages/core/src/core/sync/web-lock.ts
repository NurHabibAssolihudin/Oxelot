export class WebLock {
  constructor(private readonly locks: LockManager | undefined) {}

  get isSupported(): boolean {
    return typeof this.locks !== 'undefined'
  }

  async withLock<T>(name: string, fn: () => Promise<T>, options: { ifAvailable?: boolean } = {}): Promise<T> {
    if (!this.locks) return fn()
    return this.locks.request(name, { ifAvailable: options.ifAvailable ?? false }, fn)
  }

  async release(name: string): Promise<void> {
    void name
  }
}
