import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Oxelot } from '@oxelot/core'
import { makeStorageMutation } from '@oxelot/core'
import type { OxelotConfig, DatabaseFacade, SyncState } from '@oxelot/core'

export function useOxelot(config?: OxelotConfig): Oxelot | null {
  const [oxelot, setOxelot] = useState<Oxelot | null>(null)
  const configRef = useRef(config)
  configRef.current = config

  useEffect(() => {
    let mounted = true
    let instance: Oxelot | null = null

    void Oxelot.init(configRef.current).then((ox) => {
      if (!mounted) {
        void ox.dispose()
        return
      }
      instance = ox
      setOxelot(ox)
    })

    return () => {
      mounted = false
      if (instance) void instance.dispose()
    }
  }, [])

  return oxelot
}

/**
 * Child hooks accept an instance owned by a parent `useOxelot`. When none is
 * passed they fall back to their own `useOxelot()` call, which spawns a full
 * worker pool for that component tree — pass a shared instance to avoid it.
 */
function useSharedOxelot(instance?: Oxelot | null): Oxelot | null {
  return instance ?? null
}

export function useOxelotStorage<T>(
  key: string,
  oxelot?: Oxelot | null,
): {
  data: T | null
  loading: boolean
  error: Error | null
  write: (value: T) => Promise<void>
  remove: () => Promise<void>
} {
  const instance = useSharedOxelot(oxelot)
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const reload = useCallback(async () => {
    if (!instance) return
    setLoading(true)
    try {
      const value = await instance.storage.get<T>(key)
      setData(value)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [instance, key])

  useEffect(() => {
    void reload()
    const off = instance?.on((ev) => {
      if (ev.type === 'storage-change' && ev.key === key) void reload()
    })
    return off
  }, [instance, key, reload])

  const write = useCallback(
    async (value: T) => {
      if (!instance) return
      const snapshot = data
      // §6.3.2 optimistic apply: surface the value immediately, then make both
      // copies durable — the local storage value AND the sync envelope
      // (write-ahead). A failure rolls back to `snapshot` via a second
      // storage-change so sibling tabs see the reverted document too.
      setData(value)
      try {
        await instance.storage.set(key, value)
        await Oxelot.enqueue(instance, makeStorageMutation(key, value))
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)))
        try {
          await instance.storage.set(key, snapshot)
        } catch {
          // Best-effort rollback persist; local state is reverted regardless.
        }
        setData(snapshot)
        throw err
      }
    },
    [instance, key, data],
  )

  const remove = useCallback(async () => {
    if (!instance) return
    // Mirror write() (§6.3.2): optimistic local removal, then make both copies
    // durable — the storage delete AND a `delete` sync envelope (write-ahead).
    // A failure restores the previous value locally and via storage-change.
    const snapshot = data
    setData(null)
    try {
      await instance.storage.remove(key)
      await Oxelot.enqueue(instance, makeStorageMutation(key, null, { op: 'delete' }))
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
      try {
        await instance.storage.set(key, snapshot)
      } catch {
        // Best-effort rollback persist; local state is reverted regardless.
      }
      setData(snapshot)
      throw err
    }
  }, [instance, key, data])

  return { data, loading, error, write, remove }
}

export function useOxelotDB<T>(
  query: (db: DatabaseFacade) => Promise<T>,
  deps: unknown[] = [],
  oxelot?: Oxelot | null,
): {
  result: T | null
  loading: boolean
  error: Error | null
  refresh: () => void
} {
  const own = useOxelot()
  const instance = oxelot ?? own
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query

  useEffect(() => {
    let cancelled = false
    if (!instance) return
    setLoading(true)
    void queryRef.current(instance.db)
      .then((res) => {
        if (cancelled) return
        setResult(res)
        setError(null)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(err instanceof Error ? err : new Error(String(err)))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
    // deps intentionally spread: consumer-supplied query deps
  }, [instance, version, ...deps])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  return { result, loading, error, refresh }
}

const IDLE_SYNC_STATE: SyncState = { kind: 'idle' }

/** Value equality for `SyncState` so duplicate emits never re-render. */
function sameSyncState(a: SyncState, b: SyncState): boolean {
  return (
    a.kind === b.kind &&
    ('pending' in a ? a.pending : -1) === ('pending' in b ? b.pending : -1) &&
    ('deadLetters' in a ? a.deadLetters : -1) === ('deadLetters' in b ? b.deadLetters : -1)
  )
}

export function useOxelotSyncStatus(oxelot?: Oxelot | null): {
  state: SyncState
  pending: number
  deadLetters: number
  flush: () => Promise<void>
} {
  const own = useOxelot()
  const instance = oxelot ?? own
  const sync = instance?.sync

  // Latest state from the sync service, cached by value: `getSnapshot` must
  // return a stable reference between emits or useSyncExternalStore loops.
  const snapshotRef = useRef<{ raw: SyncState; cached: SyncState }>({
    raw: IDLE_SYNC_STATE,
    cached: IDLE_SYNC_STATE,
  })

  const apply = useCallback(
    (next: SyncState, notify: () => void): void => {
      if (!sameSyncState(snapshotRef.current.raw, next)) {
        snapshotRef.current = { raw: next, cached: next }
        notify()
      }
    },
    [],
  )

  const getSnapshot = useCallback(() => snapshotRef.current.cached, [])

  const subscribe = useCallback(
    (cb: () => void) => {
      if (!sync) return () => undefined
      let active = true
      // Seed from the persisted queue once per subscription: a remount must
      // show real pending/dead-letter counts before the next flush emits.
      // Duplicate seeds are idempotent via the sameSyncState guard.
      void sync.status().then(({ pending, deadLetters }) => {
        if (!active || pending === 0) return
        const next: SyncState =
          deadLetters > 0 ? { kind: 'dead_letter', pending, deadLetters } : { kind: 'queued', pending }
        apply(next, cb)
      })
      const off = sync.onStateChange((next) => apply(next, cb))
      return () => {
        active = false
        off()
      }
    },
    [apply, sync],
  )

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot)

  const pending = state.kind === 'idle' ? 0 : 'pending' in state ? state.pending : 0
  const deadLetters = state.kind === 'dead_letter' ? state.deadLetters : 0

  const flush = useCallback(async () => {
    await sync?.flush()
  }, [sync])

  return { state, pending, deadLetters, flush }
}
