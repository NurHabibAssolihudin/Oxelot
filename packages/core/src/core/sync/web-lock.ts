export class WebLock {
  constructor(private readonly locks: LockManager | undefined) {}

  get isSupported(): boolean {
    return typeof this.locks !== 'undefined'
  }

  async withLock<T>(name: string, fn: () => Promise<T>, options: { ifAvailable?: boolean } = {}): Promise<T> {
    if (!this.locks) return fn()
    return this.locks.request(name, { ifAvailable: options.ifAvailable ?? false }, fn)
  }

  /**
   * Acquire `name` with `ifAvailable: true` and run `fn` only if the lock was
   * actually granted. When the lock is held elsewhere (another tab/SW is
   * flushing), the callback is skipped and `{ acquired: false }` is returned so
   * callers can exit gracefully instead of competing.
   */
  async tryWithLock<T>(name: string, fn: () => Promise<T>): Promise<{ acquired: boolean; result?: T }> {
    if (!this.locks) return { acquired: true, result: await fn() }
    // The callback only runs when the lock is actually granted (ifAvailable).
    // A sentinel value disambiguates "lock unavailable" from a fn() result.
    const marker = Symbol('oxelot-lock')
    // lib.dom types request() as Promise<T>, but the spec resolves `undefined`
    // when ifAvailable cannot be granted; type the result as unknown and guard
    // at runtime so a held-vs-skipped distinction is exact.
    const payload = await this.locks.request<unknown>(
      name,
      { ifAvailable: true },
      async () => ({ marker, value: await fn() }),
    )
    if (payload !== null && typeof payload === 'object') {
      const holder = payload as { marker: typeof marker; value: T }
      if (holder.marker === marker) return { acquired: true, result: holder.value }
    }
    return { acquired: false }
  }

  async release(name: string): Promise<void> {
    void name
  }
}
