import { describe, it, expect } from 'vitest'
import { DaemonConnection, parseDaemonMessage } from '../src/core/daemon'
import type { DaemonMessage } from '../src/core/daemon'
import type { DaemonSocket, DaemonTransportFactory, DaemonTransportHandlers } from '../src/core/daemon'
import { OxelotError } from '../src/errors'

/**
 * M3.4 security-boundary fuzz (§5.4.5.6, gate: ≥ 1M malformed frames). Runs at
 * smoke depth in the default suite (`npm test`); `npm run fuzz:daemon` sets
 * `FUZZ_DAEMON=1` to run the full counts.
 */
const FULL = process.env.FUZZ_DAEMON === '1'
const PARSER_ITERATIONS = FULL ? 1_000_000 : 5_000
const CONNECTION_BATCHES = FULL ? 200 : 30
const FRAMES_PER_BATCH = 20

// ---- deterministic PRNG (fixed seed ⇒ reproducible fuzz corpus) ----

type Rng = () => number

function mulberry32(seed: number): Rng {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function pick<T>(rng: Rng, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)]!
}

// ---- frame generators ----

const ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789:.-_?/\\ \t\n\u0000\x7f\u00e9\u4e2d'

function randomString(rng: Rng, maxLen: number): string {
  const len = Math.floor(rng() * (maxLen + 1))
  let out = ''
  for (let i = 0; i < len; i++) out += ALPHABET[Math.floor(rng() * ALPHABET.length)] ?? ''
  return out
}

function randomJsonValue(rng: Rng, depth: number): unknown {
  if (depth <= 0) return rng() < 0.5 ? Math.floor(rng() * 1e6) : randomString(rng, 20)
  const kind = Math.floor(rng() * 7)
  switch (kind) {
    case 0:
      return null
    case 1:
      return rng() < 0.5
    case 2:
      return Math.floor(rng() * 1e6) * (rng() < 0.5 ? 1 : -1)
    case 3:
      return rng() * 1e308
    case 4:
      return randomString(rng, 40)
    case 5: {
      const n = Math.floor(rng() * 5)
      const arr: unknown[] = []
      for (let i = 0; i < n; i++) arr.push(randomJsonValue(rng, depth - 1))
      return arr
    }
    default: {
      const obj: Record<string, unknown> = {}
      const n = Math.floor(rng() * 5)
      for (let i = 0; i < n; i++) obj[randomString(rng, 12)] = randomJsonValue(rng, depth - 1)
      return obj
    }
  }
}

const VALID_FRAMES: readonly Record<string, unknown>[] = [
  { type: 'hello', app: 'oxelot', protocolVersion: 1, clientId: 'c-123' },
  { type: 'advertise', protocolVersion: 1, caps: [{ cap: 'serial:read', permission: true }] },
  { type: 'request', protocolVersion: 1, id: 'r1', cap: 'serial:read', data: { handle: 'h', size: 5 } },
  { type: 'response', protocolVersion: 1, id: 'r1', cap: 'serial:read', ok: true, data: { bytes: 'aGk=' } },
  { type: 'response', protocolVersion: 1, id: 'r1', cap: 'serial:read', ok: false, error: { code: 'ERR_PERMISSION_DENIED', message: 'nope' } },
  { type: 'event', protocolVersion: 1, cap: 'file:watch', data: { path: '/tmp/x' } },
  { type: 'ping' },
  { type: 'pong' },
]

const TYPES = ['hello', 'advertise', 'request', 'response', 'event', 'ping', 'pong', 'nope']

function generateFrame(rng: Rng): string {
  const mode = Math.floor(rng() * 6)
  switch (mode) {
    case 0:
      // Pure random JSON shapes.
      return JSON.stringify(randomJsonValue(rng, 3))
    case 1:
      // Raw garbage (binary, whitespace, control, unicode, quotes).
      return randomString(rng, 128)
    case 2: {
      // Truncated JSON of a valid frame.
      const s = JSON.stringify(pick(rng, VALID_FRAMES))
      return s.slice(0, Math.floor(rng() * (s.length + 1)))
    }
    case 3: {
      // Field-level mutation of a valid frame.
      const base = structuredClone(pick(rng, VALID_FRAMES))
      const keys = Object.keys(base)
      const op = Math.floor(rng() * 4)
      if (op === 0 && keys.length > 0) {
        base[pick(rng, keys)] = randomJsonValue(rng, 2)
      } else if (op === 1 && keys.length > 0) {
        // `undefined` values are dropped by JSON.stringify, mirroring a delete.
        base[pick(rng, keys)] = undefined
      } else if (op === 2) {
        base[randomString(rng, 10)] = randomJsonValue(rng, 2)
      } else {
        base.type = pick(rng, TYPES)
      }
      return JSON.stringify(base)
    }
    case 4: {
      // Raw-string corruption of a valid frame.
      const s = JSON.stringify(pick(rng, VALID_FRAMES))
      const pos = Math.floor(rng() * s.length)
      return s.slice(0, pos) + randomString(rng, 3) + s.slice(pos + 3)
    }
    default:
      // Sometimes hand the parser an unmodified valid frame.
      return JSON.stringify(pick(rng, VALID_FRAMES))
  }
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now()
    const tick = (): void => {
      if (predicate()) {
        resolve()
        return
      }
      if (Date.now() - start > timeoutMs) {
        reject(new Error('waitFor timed out'))
        return
      }
      setTimeout(tick, 5)
    }
    tick()
  })
}

describe('M3.4 fuzz — daemon schema parser', () => {
  it('malformed frames never throw outside OxelotError and accepted frames round-trip', () => {
    const rng = mulberry32(0xda3f00)
    let accepted = 0
    let schema = 0
    let version = 0
    for (let i = 0; i < PARSER_ITERATIONS; i++) {
      const raw = generateFrame(rng)
      let msg: DaemonMessage
      try {
        msg = parseDaemonMessage(raw)
      } catch (err) {
        expect(err).toBeInstanceOf(OxelotError)
        const code = (err as OxelotError).code
        expect(code === 'ERR_DAEMON_SCHEMA' || code === 'ERR_DAEMON_VERSION').toBe(true)
        if (code === 'ERR_DAEMON_SCHEMA') schema++
        else version++
        continue
      }
      accepted++
      // Idempotence: re-parsing the parser's own output must be stable.
      const again = parseDaemonMessage(JSON.stringify(msg))
      expect(again.type).toBe(msg.type)
    }
    expect(accepted + schema + version).toBe(PARSER_ITERATIONS)
    expect(accepted).toBeGreaterThan(0)
  })
})

describe('M3.4 fuzz — handshake boundary', () => {
  class FuzzSocket implements DaemonSocket {
    closed = false
    constructor(private readonly handlers: DaemonTransportHandlers) {}
    send(): void {}
    receive(raw: string): void {
      this.handlers.onMessage(raw)
    }
    close(): void {
      this.closed = true
    }
  }

  function makeHarness(): { conn: DaemonConnection; sockets: FuzzSocket[]; latest(): FuzzSocket } {
    const sockets: FuzzSocket[] = []
    const factory: DaemonTransportFactory = {
      kind: 'fuzz',
      open: (_url, handlers) => {
        const socket = new FuzzSocket(handlers)
        sockets.push(socket)
        return socket
      },
    }
    const conn = new DaemonConnection({
      url: 'ws://127.0.0.1:9090',
      transports: [factory],
      backoff: { baseMs: 2, multiplier: 2, maxMs: 8 },
    })
    void conn.connect()
    return { conn, sockets, latest: () => sockets[sockets.length - 1]! }
  }

  it('garbage can never reach ready on its own; a valid advertise still completes the handshake', async () => {
    const rng = mulberry32(0xb0d3)
    const VALID_ADVERTISE = JSON.stringify({ type: 'advertise', protocolVersion: 1, caps: [{ cap: 'serial:read', permission: true }] })

    for (let batch = 0; batch < CONNECTION_BATCHES; batch++) {
      const h = makeHarness()
      for (let i = 0; i < FRAMES_PER_BATCH; i++) {
        h.latest().receive(generateFrame(rng))
        expect(['disconnected', 'connecting', 'ready']).toContain(h.conn.state)
      }

      if (h.conn.state === 'connecting') {
        // Garbage neither completed nor tore down the handshake: a valid
        // advertise must still transition to ready.
        h.latest().receive(VALID_ADVERTISE)
        expect(h.conn.state).toBe('ready')
      } else if (h.conn.state === 'disconnected') {
        // Garbage tripped a schema reset: the retry cycle opens a fresh socket;
        // a valid advertise on it must reach ready (no permanent DoS).
        await waitFor(() => h.sockets.length > 1)
        h.latest().receive(VALID_ADVERTISE)
        expect(h.conn.state).toBe('ready')
      }
      // state === 'ready' here means the batch happened to contain a fully valid
      // advertise — legitimate; nothing further to prove for this batch.

      await h.conn.dispose()
    }
  })
})
