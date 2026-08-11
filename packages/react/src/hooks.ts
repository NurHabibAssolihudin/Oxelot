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
 * Child hooks reuse an instance owned by a parent `useOxelot`; they never spawn
 * their own pool. Callers that want a standalone hook should own the instance
 * with `useOxelot()` and pass it in.
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
    await instance.storage.remove(key)
    setData(null)
  }, [instance, key])

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

export function useOxelotSyncStatus(oxelot?: Oxelot | null): {
  state: SyncState
  pending: number
  deadLetters: number
  flush: () => Promise<void>
} {
  const own = useOxelot()
  const instance = oxelot ?? own
  const sync = instance?.sync

  const state = useSyncExternalStore<SyncState>(
    (cb) => {
      const off = sync?.onStateChange(cb)
      return off ?? (() => undefined)
    },
    () => IDLE_SYNC_STATE,
  )

  useEffect(() => {
    if (!sync) return
    void sync.status().then(({ pending, deadLetters }) => {
      if (pending > 0 || deadLetters > 0) {
        sync.onStateChange(() => undefined)
      }
    })
  }, [sync])

  const pending = state.kind === 'idle' ? 0 : 'pending' in state ? state.pending : 0
  const deadLetters = state.kind === 'dead_letter' ? state.deadLetters : 0

  const flush = useCallback(async () => {
    await sync?.flush()
  }, [sync])

  return { state, pending, deadLetters, flush }
}
