// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Mock } from 'vitest'
import type { Oxelot } from '@oxelot/core'
import { useOxelot, useOxelotDB, useOxelotStorage, useOxelotSyncStatus } from '../src/hooks'

interface ChangeEvent {
  type: string
  key?: string
  sourceTab?: string
}

interface SyncStateLike {
  kind: 'idle' | 'queued' | 'syncing' | 'dead_letter'
  pending?: number
  deadLetters?: number
}

interface EnvelopeLike {
  id: string
  schemaVersion: number
  collection: string
  op: string
  payload: unknown
  createdAt: number
  attempts: number
}

interface FakeInstance {
  storage: {
    get: Mock<(key: string) => Promise<unknown>>
    set: Mock<(key: string, value: unknown) => Promise<void>>
    remove: Mock<(key: string) => Promise<void>>
  }
  db: {
    query: Mock<(...args: unknown[]) => Promise<unknown[]>>
  }
  sync: {
    enqueue: Mock<(m?: unknown) => Promise<void>>
    flush: Mock<() => Promise<{ delivered: number; deadLetters: number }>>
    status: Mock<() => Promise<{ pending: number; deadLetters: number }>>
    onStateChange: Mock<(cb: (s: SyncStateLike) => void) => () => boolean>
  }
  on: Mock<(cb: (ev: ChangeEvent) => void) => () => boolean>
  dispose: Mock<() => Promise<void>>
  __emitChange: (ev: ChangeEvent) => void
  __emitSyncState: (s: SyncStateLike) => void
}

/**
 * Hermetic fake of `@oxelot/core`: no Worker, no OPFS, no IndexedDB. Each test
 * mounts hooks against a `makeInstance()` fake passed as the shared instance.
 */
const core = vi.hoisted(() => {
  const state = {
    initImpl: null as null | (() => Promise<unknown>),
    last: null as FakeInstance | null,
    inits: [] as unknown[],
    enqueued: [] as { ox: FakeInstance; m: unknown }[],
  }

  function makeInstance(): FakeInstance {
    const changeListeners = new Set<(ev: ChangeEvent) => void>()
    const syncListeners = new Set<(s: SyncStateLike) => void>()
    return {
      storage: {
        get: vi.fn(async (_key: string) => null),
        set: vi.fn(async (_key: string, _value: unknown) => undefined),
        remove: vi.fn(async (_key: string) => undefined),
      },
      db: {
        query: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
      },
      sync: {
        enqueue: vi.fn(async (_m?: unknown) => undefined),
        flush: vi.fn(async () => ({ delivered: 0, deadLetters: 0 })),
        status: vi.fn(async () => ({ pending: 0, deadLetters: 0 })),
        onStateChange: vi.fn((cb: (s: SyncStateLike) => void) => {
          syncListeners.add(cb)
          return (): boolean => syncListeners.delete(cb)
        }),
      },
      on: vi.fn((cb: (ev: ChangeEvent) => void) => {
        changeListeners.add(cb)
        return (): boolean => changeListeners.delete(cb)
      }),
      dispose: vi.fn(async () => undefined),
      __emitChange: (ev: ChangeEvent): void => {
        for (const cb of [...changeListeners]) cb(ev)
      },
      __emitSyncState: (s: SyncStateLike): void => {
        for (const cb of [...syncListeners]) cb(s)
      },
    }
  }

  const Oxelot = {
    init(config?: unknown): Promise<unknown> {
      state.inits.push(config)
      if (state.initImpl) return state.initImpl()
      const inst = makeInstance()
      state.last = inst
      return Promise.resolve(inst)
    },
    enqueue(ox: FakeInstance, m: unknown): Promise<void> {
      state.enqueued.push({ ox, m })
      return ox.sync.enqueue(m)
    },
  }

  function makeStorageMutation(
    key: string,
    value: unknown,
    opts?: { op?: 'upsert' | 'delete'; now?: () => number; newId?: () => string },
  ): EnvelopeLike {
    return {
      id: opts?.newId ? opts.newId() : 'test-id',
      schemaVersion: 1,
      collection: `storage:${key}`,
      op: opts?.op ?? 'upsert',
      payload: value,
      createdAt: opts?.now ? opts.now() : 0,
      attempts: 0,
    }
  }

  return { state, makeInstance, Oxelot, makeStorageMutation }
})

vi.mock('@oxelot/core', () => ({
  Oxelot: core.Oxelot,
  makeStorageMutation: core.makeStorageMutation,
}))

type Instance = ReturnType<typeof core.makeInstance>

function asOxelot(inst: Instance): Oxelot {
  return inst as unknown as Oxelot
}

function envelopeAt(i: number): EnvelopeLike {
  return core.state.enqueued[i]?.m as EnvelopeLike
}

beforeEach(() => {
  core.state.initImpl = null
  core.state.last = null
  core.state.inits.length = 0
  core.state.enqueued.length = 0
})

afterEach(() => {
  cleanup()
})

describe('useOxelot', () => {
  it('initializes once with the given config and exposes the instance', async () => {
    const { result } = renderHook(() => useOxelot({ dbName: 'catalog.db' }))
    expect(core.state.inits).toEqual([{ dbName: 'catalog.db' }])
    await waitFor(() => expect(result.current).not.toBeNull())
    const inst = core.state.last as Instance
    expect(result.current).toBe(asOxelot(inst))
  })

  it('disposes the instance on unmount', async () => {
    const { result, unmount } = renderHook(() => useOxelot())
    await waitFor(() => expect(result.current).not.toBeNull())
    const inst = result.current as unknown as Instance
    unmount()
    expect(inst.dispose).toHaveBeenCalledTimes(1)
  })

  it('disposes the orphaned instance when unmounted before init resolves', async () => {
    const orphan = core.makeInstance()
    let release!: () => void
    core.state.initImpl = () => new Promise<unknown>((resolve) => {
      release = () => resolve(orphan)
    })
    const { unmount } = renderHook(() => useOxelot())
    unmount()
    release()
    await waitFor(() => expect(orphan.dispose).toHaveBeenCalledTimes(1))
  })
})

describe('useOxelotStorage', () => {
  async function mounted(inst: Instance, key = 'k') {
    const utils = renderHook(() => useOxelotStorage(key, asOxelot(inst)))
    await waitFor(() => expect(utils.result.current.loading).toBe(false))
    return utils
  }

  it('loads the initial value from storage', async () => {
    const inst = core.makeInstance()
    inst.storage.get.mockResolvedValue({ hello: 'oxelot' })
    const { result } = await mounted(inst)
    expect(inst.storage.get).toHaveBeenCalledWith('k')
    expect(result.current.data).toEqual({ hello: 'oxelot' })
    expect(result.current.error).toBeNull()
  })

  it('write persists locally and enqueues an upsert envelope (D8)', async () => {
    const inst = core.makeInstance()
    const { result } = await mounted(inst)
    await act(async () => {
      await result.current.write({ v: 2 })
    })
    expect(inst.storage.set).toHaveBeenCalledWith('k', { v: 2 })
    expect(core.state.enqueued).toHaveLength(1)
    expect(envelopeAt(0)).toMatchObject({ collection: 'storage:k', op: 'upsert', payload: { v: 2 } })
    expect(result.current.data).toEqual({ v: 2 })
  })

  it('failed write rolls back local state and storage, surfaces the error', async () => {
    const inst = core.makeInstance()
    inst.storage.get.mockResolvedValue('saved')
    const { result } = await mounted(inst)
    inst.storage.set.mockRejectedValueOnce(new Error('disk full'))
    let caught: unknown = null
    await act(async () => {
      try {
        await result.current.write('next')
      } catch (err) {
        caught = err
      }
    })
    expect(caught).toBeInstanceOf(Error)
    expect(result.current.error).toBeInstanceOf(Error)
    expect(result.current.data).toBe('saved')
    expect(inst.storage.set).toHaveBeenNthCalledWith(2, 'k', 'saved')
  })

  it('reloads when a matching storage-change arrives, ignores other keys', async () => {
    const inst = core.makeInstance()
    const { result } = await mounted(inst)
    inst.storage.get.mockResolvedValueOnce('updated')
    act(() => {
      inst.__emitChange({ type: 'storage-change', key: 'k', sourceTab: 'other-tab' })
    })
    await waitFor(() => expect(result.current.data).toBe('updated'))
    const callsAfterMatch = inst.storage.get.mock.calls.length
    act(() => {
      inst.__emitChange({ type: 'storage-change', key: 'other-key', sourceTab: 'other-tab' })
    })
    await act(async () => {
      await Promise.resolve()
    })
    expect(inst.storage.get.mock.calls.length).toBe(callsAfterMatch)
  })

  it('remove deletes locally and enqueues a delete envelope', async () => {
    const inst = core.makeInstance()
    inst.storage.get.mockResolvedValue('v1')
    const { result } = await mounted(inst)
    await act(async () => {
      await result.current.remove()
    })
    expect(inst.storage.remove).toHaveBeenCalledWith('k')
    expect(core.state.enqueued).toHaveLength(1)
    expect(envelopeAt(0)).toMatchObject({ collection: 'storage:k', op: 'delete', payload: null })
    expect(result.current.data).toBeNull()
  })

  it('failed remove restores the previous value and enqueues nothing', async () => {
    const inst = core.makeInstance()
    inst.storage.get.mockResolvedValue('v1')
    const { result } = await mounted(inst)
    inst.storage.remove.mockRejectedValueOnce(new Error('boom'))
    let caught: unknown = null
    await act(async () => {
      try {
        await result.current.remove()
      } catch (err) {
        caught = err
      }
    })
    expect(caught).toBeInstanceOf(Error)
    expect(result.current.data).toBe('v1')
    expect(inst.storage.set).toHaveBeenCalledWith('k', 'v1')
    expect(core.state.enqueued).toHaveLength(0)
  })
})

describe('useOxelotDB', () => {
  it('runs the query against the shared instance db', async () => {
    const inst = core.makeInstance()
    inst.db.query.mockResolvedValue([{ id: 1 }])
    const { result } = renderHook(() =>
      useOxelotDB((db) => db.query('select 1'), [], asOxelot(inst)),
    )
    await waitFor(() => expect(result.current.result).toEqual([{ id: 1 }]))
    expect(inst.db.query).toHaveBeenCalledWith('select 1')
    expect(result.current.loading).toBe(false)
  })

  it('refresh re-runs the query', async () => {
    const inst = core.makeInstance()
    let n = 0
    inst.db.query.mockImplementation(async () => {
      n += 1
      return [n]
    })
    const { result } = renderHook(() =>
      useOxelotDB((db) => db.query('select 1'), [], asOxelot(inst)),
    )
    await waitFor(() => expect(result.current.result).toEqual([1]))
    act(() => {
      result.current.refresh()
    })
    await waitFor(() => expect(result.current.result).toEqual([2]))
    expect(inst.db.query).toHaveBeenCalledTimes(2)
  })

  it('surfaces query errors', async () => {
    const inst = core.makeInstance()
    inst.db.query.mockRejectedValue(new Error('sql fail'))
    const { result } = renderHook(() =>
      useOxelotDB((db) => db.query('broken'), [], asOxelot(inst)),
    )
    await waitFor(() => expect(result.current.error).toBeInstanceOf(Error))
    expect(result.current.result).toBeNull()
    expect(result.current.loading).toBe(false)
  })

  it('ignores stale responses after a dep change', async () => {
    const inst = core.makeInstance()
    const resolvers: Array<(v: unknown[]) => void> = []
    inst.db.query.mockImplementation(
      () => new Promise<unknown[]>((resolve) => {
        resolvers.push(resolve)
      }),
    )
    const { result, rerender } = renderHook(
      ({ dep }: { dep: number }) =>
        useOxelotDB((db) => db.query(`q${dep}`), [dep], asOxelot(inst)),
      { initialProps: { dep: 1 } },
    )
    rerender({ dep: 2 })
    await act(async () => {
      resolvers[1]?.([{ fresh: true }])
      resolvers[0]?.([{ stale: true }])
    })
    await waitFor(() => expect(result.current.result).toEqual([{ fresh: true }]))
    expect(result.current.loading).toBe(false)
  })
})

describe('useOxelotSyncStatus', () => {
  it('starts idle and reflects emitted sync states (regression: snapshot bug)', async () => {
    const inst = core.makeInstance()
    const { result } = renderHook(() => useOxelotSyncStatus(asOxelot(inst)))
    expect(result.current.state).toEqual({ kind: 'idle' })
    expect(result.current.pending).toBe(0)

    act(() => {
      inst.__emitSyncState({ kind: 'syncing', pending: 3 })
    })
    expect(result.current.state).toEqual({ kind: 'syncing', pending: 3 })
    expect(result.current.pending).toBe(3)

    act(() => {
      inst.__emitSyncState({ kind: 'dead_letter', pending: 1, deadLetters: 2 })
    })
    expect(result.current.state).toEqual({ kind: 'dead_letter', pending: 1, deadLetters: 2 })
    expect(result.current.deadLetters).toBe(2)

    act(() => {
      inst.__emitSyncState({ kind: 'idle' })
    })
    expect(result.current.state).toEqual({ kind: 'idle' })
    expect(result.current.pending).toBe(0)
  })

  it('seeds pending counts from the persisted queue on mount', async () => {
    const inst = core.makeInstance()
    inst.sync.status.mockResolvedValue({ pending: 4, deadLetters: 0 })
    const { result } = renderHook(() => useOxelotSyncStatus(asOxelot(inst)))
    await waitFor(() => expect(result.current.pending).toBe(4))
    expect(result.current.state).toEqual({ kind: 'queued', pending: 4 })
  })

  it('seeds dead letters from the persisted queue on mount', async () => {
    const inst = core.makeInstance()
    inst.sync.status.mockResolvedValue({ pending: 2, deadLetters: 5 })
    const { result } = renderHook(() => useOxelotSyncStatus(asOxelot(inst)))
    await waitFor(() => expect(result.current.deadLetters).toBe(5))
    expect(result.current.state).toEqual({ kind: 'dead_letter', pending: 2, deadLetters: 5 })
  })

  it('flush delegates to the sync service', async () => {
    const inst = core.makeInstance()
    const { result } = renderHook(() => useOxelotSyncStatus(asOxelot(inst)))
    await act(async () => {
      await result.current.flush()
    })
    expect(inst.sync.flush).toHaveBeenCalledTimes(1)
  })

  it('keeps a stable snapshot across duplicate emits', async () => {
    const inst = core.makeInstance()
    const { result } = renderHook(() => useOxelotSyncStatus(asOxelot(inst)))
    const first = result.current.state
    act(() => {
      inst.__emitSyncState({ kind: 'queued', pending: 1 })
    })
    const second = result.current.state
    act(() => {
      inst.__emitSyncState({ kind: 'queued', pending: 1 })
    })
    expect(result.current.state).toBe(second)
    expect(first).not.toBe(second)
  })
})
