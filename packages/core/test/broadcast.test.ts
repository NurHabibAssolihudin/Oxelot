import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { StorageBroadcast, getSourceTab, STORAGE_CHANNEL } from '../src/core/broadcast'

type Handler = (ev: { data: unknown }) => void

class FakeChannel {
  static instances: FakeChannel[] = []
  readonly listeners = new Set<Handler>()
  closed = false
  constructor(readonly name: string) {
    FakeChannel.instances.push(this)
  }
  postMessage(data: unknown): void {
    // Deliver to every channel on the same name (including self, like real BC).
    for (const ch of FakeChannel.instances) {
      if (ch !== this && ch.name === this.name) {
        for (const h of ch.listeners) h({ data })
      }
    }
  }
  addEventListener(_t: string, h: Handler): void {
    this.listeners.add(h)
  }
  removeEventListener(_t: string, h: Handler): void {
    this.listeners.delete(h)
  }
  close(): void {
    this.closed = true
  }
}

const storage = new Map<string, string>()

beforeEach(() => {
  FakeChannel.instances = []
  storage.clear()
  vi.stubGlobal('BroadcastChannel', FakeChannel)
  vi.stubGlobal('sessionStorage', {
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, v),
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('getSourceTab', () => {
  it('returns a stable id within a session', () => {
    const a = getSourceTab()
    const b = getSourceTab()
    expect(a).toBe(b)
    expect(a.startsWith('tab-')).toBe(true)
  })

  it('returns a different id across sessions', () => {
    const a = getSourceTab()
    storage.clear()
    const b = getSourceTab()
    expect(a).not.toBe(b)
  })
})

describe('StorageBroadcast', () => {
  it('delivers a message to sibling tabs only (echo filtered by sourceTab)', () => {
    const b1 = new StorageBroadcast(STORAGE_CHANNEL)
    const b2 = new StorageBroadcast(STORAGE_CHANNEL)
    const received: unknown[] = []
    b2.onRemote((m) => received.push(m))

    b1.broadcast({ key: 'k', sourceTab: 'tab-A' })
    expect(received).toEqual([{ key: 'k', sourceTab: 'tab-A' }])

    // The receiver filters its own tab.
    const self = getSourceTab()
    const own: unknown[] = []
    b2.onRemote((m) => own.push(m))
    b2.broadcast({ key: 'self', sourceTab: self })
    expect(own).toEqual([])
  })

  it('ignores malformed messages', () => {
    const b = new StorageBroadcast(STORAGE_CHANNEL)
    const received: unknown[] = []
    b.onRemote((m) => received.push(m))
    const ch = FakeChannel.instances[0]!
    ch.listeners.forEach((h) => h({ data: { foo: 1 } }))
    expect(received).toEqual([])
  })

  it('degrades to a no-op without BroadcastChannel', () => {
    vi.stubGlobal('BroadcastChannel', undefined)
    const b = new StorageBroadcast(STORAGE_CHANNEL)
    expect(() => b.broadcast({ key: 'k', sourceTab: 't' })).not.toThrow()
    expect(b.onRemote(() => undefined)).toBeTypeOf('function')
  })

  it('dispose closes the channel', () => {
    const b = new StorageBroadcast(STORAGE_CHANNEL)
    const ch = FakeChannel.instances[0]!
    b.dispose()
    expect(ch.closed).toBe(true)
  })
})
