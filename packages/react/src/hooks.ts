import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Oxelot } from '@oxelot/core'
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

export function useOxelotStorage<T>(key: string): {
  data: T | null
  loading: boolean
  error: Error | null
  write: (value: T) => Promise<void>
  remove: () => Promise<void>
} {
  const oxelot = useOxelot()
  const [data, setData] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)

  const reload = useCallback(async () => {
    if (!oxelot) return
    setLoading(true)
    try {
      const value = await oxelot.storage.get<T>(key)
      setData(value)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)))
    } finally {
      setLoading(false)
    }
  }, [oxelot, key])

  useEffect(() => {
    void reload()
    const off = oxelot?.on((ev) => {
      if (ev.type === 'storage-change' && ev.key === key) void reload()
    })
    return off
  }, [oxelot, key, reload])

  const write = useCallback(
    async (value: T) => {
      if (!oxelot) return
      setData(value)
      try {
        await oxelot.storage.set(key, value)
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)))
        throw err
      }
    },
    [oxelot, key],
  )

  const remove = useCallback(async () => {
    if (!oxelot) return
    await oxelot.storage.remove(key)
    setData(null)
  }, [oxelot, key])

  return { data, loading, error, write, remove }
}

export function useOxelotDB<T>(
  query: (db: DatabaseFacade) => Promise<T>,
  deps: unknown[] = [],
): {
  result: T | null
  loading: boolean
  error: Error | null
  refresh: () => void
} {
  const oxelot = useOxelot()
  const [version, setVersion] = useState(0)
  const [result, setResult] = useState<T | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<Error | null>(null)
  const queryRef = useRef(query)
  queryRef.current = query

  useEffect(() => {
    let cancelled = false
    if (!oxelot) return
    setLoading(true)
    void queryRef.current(oxelot.db)
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
  }, [oxelot, version, ...deps])

  const refresh = useCallback(() => setVersion((v) => v + 1), [])

  return { result, loading, error, refresh }
}

export function useOxelotSyncStatus(): {
  state: SyncState
  pending: number
  deadLetters: number
  flush: () => Promise<void>
} {
  const oxelot = useOxelot()
  const sync = oxelot?.sync

  const state = useSyncExternalStore<SyncState>(
    (cb) => {
      const off = sync?.onStateChange(cb)
      return off ?? (() => undefined)
    },
    () => ({ kind: 'idle' } as const),
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
