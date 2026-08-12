import { describe, it, expect } from 'vitest'
import { DaemonConnection, nextBackoffDelay, parseDaemonMessage, DAEMON_PROTOCOL_VERSION, DaemonBridge } from '../src/core/daemon'
import { GrantGate, describeCapability, DAEMON_REGISTRY, encodeBytes, decodeBytes } from '../src/core/daemon'
import type { DaemonSocket, DaemonTransportFactory, DaemonTransportHandlers } from '../src/core/daemon'
import { OxelotError } from '../src/errors'

class FakeSocket implements DaemonSocket {
  closed = false
  sent: string[] = []
  constructor(
    private readonly url: string,
    private readonly handlers: DaemonTransportHandlers,
  ) {}

  send(data: string): void {
    this.sent.push(data)
  }

  receive(raw: string): void {
    this.handlers.onMessage(raw)
  }

  drop(err?: Error): void {
    this.closed = true
    this.handlers.onClose(err)
  }

  close(): void {
    this.closed = true
  }
}

class FakeServer {
  sockets: FakeSocket[] = []

  last(): FakeSocket {
    const s = this.sockets[this.sockets.length - 1]
    if (!s) throw new Error('no socket opened yet')
    return s
  }

  factory: DaemonTransportFactory = {
    kind: 'test',
    open: (url, handlers) => {
      const socket = new FakeSocket(url, handlers)
      this.sockets.push(socket)
      return socket
    },
  }

  advertise(caps: { cap: string; permission: boolean }[]): FakeSocket {
    const s = this.last()
    s.receive(JSON.stringify({ type: 'advertise', protocolVersion: DAEMON_PROTOCOL_VERSION, caps }))
    return s
  }
}

function alwaysFails(err: Error): DaemonTransportFactory {
  return {
    kind: 'failing',
    open: (_url, handlers) => {
      queueMicrotask(() => handlers.onClose(err))
      return { closed: true, send() {}, close() {} }
    },
  }
}

function neverConnects(): DaemonTransportFactory {
  return { kind: 'never', open: () => ({ closed: true, send() {}, close() {} }) }
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

describe('parseDaemonMessage', () => {
  it('parses hello', () => {
    const msg = parseDaemonMessage(JSON.stringify({ type: 'hello', app: 'oxelot', protocolVersion: 1, clientId: 'c' }))
    expect(msg).toMatchObject({ type: 'hello', app: 'oxelot', clientId: 'c' })
  })

  it('parses advertise with optional schema', () => {
    const msg = parseDaemonMessage(
      JSON.stringify({
        type: 'advertise',
        protocolVersion: 1,
        caps: [
          { cap: 'kv.get', permission: true },
          { cap: 'file:get', permission: false, schema: { auth: 'none' } },
        ],
      }),
    )
    expect(msg.type).toBe('advertise')
    if (msg.type === 'advertise') {
      expect(msg.caps).toEqual([
        { cap: 'kv.get', permission: true },
        { cap: 'file:get', permission: false, schema: { auth: 'none' } },
      ])
    }
  })

  it('parses request / response / event / ping / pong', () => {
    expect(parseDaemonMessage(JSON.stringify({ type: 'request', protocolVersion: 1, id: 'r1', cap: 'c', data: { x: 1 } }))).toMatchObject({ type: 'request', id: 'r1' })
    expect(parseDaemonMessage(JSON.stringify({ type: 'response', protocolVersion: 1, id: 'r1', cap: 'c', ok: true, data: 7 }))).toMatchObject({ type: 'response', ok: true })
    expect(
      parseDaemonMessage(JSON.stringify({ type: 'response', protocolVersion: 1, id: 'r1', cap: 'c', ok: false, error: { code: 'X', message: 'y' } })),
    ).toMatchObject({ type: 'response', ok: false })
    expect(parseDaemonMessage(JSON.stringify({ type: 'event', protocolVersion: 1, cap: 'c', data: 'd' }))).toMatchObject({ type: 'event' })
    expect(parseDaemonMessage('{"type":"ping"}')).toEqual({ type: 'ping' })
    expect(parseDaemonMessage('{"type":"pong"}')).toEqual({ type: 'pong' })
  })

  it('rejects non-JSON, structural, and version violations as OxelotError', () => {
    expect(() => parseDaemonMessage('not json')).toThrowError(OxelotError)
    expect(() => parseDaemonMessage(JSON.stringify({ type: 'request', protocolVersion: DAEMON_PROTOCOL_VERSION + 1, id: 'r', cap: 'c' }))).toThrowError(
      OxelotError,
    )
    expect(() => parseDaemonMessage('{"type":"nope"}')).toThrowError(OxelotError)
    expect(() => parseDaemonMessage(JSON.stringify({ type: 'advertise', protocolVersion: 1, caps: [{ cap: 1, permission: true }] }))).toThrowError(
      OxelotError,
    )
    expect(() => parseDaemonMessage(JSON.stringify({ type: 'response', protocolVersion: 1, id: 'r', cap: 'c', ok: 'yes' }))).toThrowError(OxelotError)
  })
})

describe('nextBackoffDelay', () => {
  it('follows base * multiplier^attempt capped at max', () => {
    expect(nextBackoffDelay(0, { baseMs: 500, multiplier: 2, maxMs: 30000 })).toBe(500)
    expect(nextBackoffDelay(1, { baseMs: 500, multiplier: 2, maxMs: 30000 })).toBe(1000)
    expect(nextBackoffDelay(2, { baseMs: 500, multiplier: 2, maxMs: 30000 })).toBe(2000)
    expect(nextBackoffDelay(10, { baseMs: 500, multiplier: 2, maxMs: 30000 })).toBe(30000)
  })
})

describe('DaemonConnection handshake', () => {
  it('reaches ready and exposes advertised caps', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [server.factory] })
    const ready = conn.connect()
    const socket = server.last()
    expect(socket.sent[0]?.includes('"hello"')).toBe(true)
    server.advertise([{ cap: 'kv.get', permission: true }, { cap: 'file:get', permission: false }])
    await ready
    expect(conn.state).toBe('ready')
    expect(conn.caps()).toContain('kv.get')
    expect(conn.caps()).toContain('file:get')
  })

  it('invokes state listeners', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [server.factory] })
    const states: string[] = []
    conn.onStateChange((s) => states.push(s))
    const ready = conn.connect()
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready
    expect(states).toEqual(['connecting', 'ready'])
  })

  it('refuses non-localhost daemon URLs (§5.4.5)', () => {
    expect(() => new DaemonConnection({ url: 'ws://evil.example:47500', transports: [new FakeServer().factory] })).toThrowError(OxelotError)
  })

  it('falls through transports in order', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [alwaysFails(new Error('no')), server.factory] })
    const ready = conn.connect()
    await waitFor(() => server.sockets.length === 1)
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready
    expect(conn.state).toBe('ready')
  })

  it('rejects connect() after dispose (retries in background otherwise)', async () => {
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [alwaysFails(new Error('no')), alwaysFails(new Error('no'))] })
    const p = conn.connect()
    const disposed = conn.dispose()
    await expect(p).rejects.toMatchObject({ code: 'ERR_DAEMON_CONNECT' })
    await disposed
  })
})

describe('DaemonConnection rpc', () => {
  it('correlates request/response by id', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [server.factory] })
    const ready = conn.connect()
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready

    const p = conn.request('kv.get', { key: 'a' })
    const frame = JSON.parse(server.last().sent.at(-1) ?? '') as { id: string }
    expect(frame.id).toBeTruthy()
    server.last().receive(JSON.stringify({ type: 'response', protocolVersion: 1, id: frame.id, cap: 'kv.get', ok: true, data: { value: 1 } }))
    await expect(p).resolves.toEqual({ value: 1 })
  })

  it('maps daemon error codes onto OxelotError codes', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [server.factory] })
    const ready = conn.connect()
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready

    const p = conn.request('kv.get')
    const frame = JSON.parse(server.last().sent.at(-1) ?? '') as { id: string }
    server.last().receive(
      JSON.stringify({ type: 'response', protocolVersion: 1, id: frame.id, cap: 'kv.get', ok: false, error: { code: 'ERR_PERMISSION_DENIED', message: 'nope' } }),
    )
    await expect(p).rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' })
  })

  it('rejects requests when not ready', async () => {
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [neverConnects()] })
    await expect(conn.request('kv.get')).rejects.toMatchObject({ code: 'ERR_DAEMON_CONNECT' })
  })

  it('times out pending requests', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [server.factory], requestTimeoutMs: 20, connectTimeoutMs: 5000 })
    const ready = conn.connect()
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready
    await expect(conn.request('kv.get')).rejects.toMatchObject({ code: 'ERR_DAEMON_TIMEOUT' })
  })

  it('resets via reconnect when the daemon closes a ready connection', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({ url: 'ws://127.0.0.1:9090', transports: [server.factory], backoff: { baseMs: 5, multiplier: 2, maxMs: 50 } })
    const ready = conn.connect()
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready
    server.last().drop(new Error('gone'))
    await waitFor(() => conn.state === 'disconnected')
    await waitFor(() => server.sockets.length >= 2)
    server.advertise([{ cap: 'kv.get', permission: true }])
    await waitFor(() => conn.state === 'ready')
  })

  it('resets when heartbeats are missed', async () => {
    const server = new FakeServer()
    const conn = new DaemonConnection({
      url: 'ws://127.0.0.1:9090',
      transports: [server.factory],
      heartbeatIntervalMs: 10,
      heartbeatTimeoutMs: 5,
      maxMissedBeats: 2,
      backoff: { baseMs: 5, multiplier: 2, maxMs: 50 },
    })
    const ready = conn.connect()
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready
    await waitFor(() => server.sockets.length >= 2, 4000)
  })
})

describe('DaemonBridge', () => {
  it('rejects unsupported capabilities before sending', async () => {
    const server = new FakeServer()
    const bridge = new DaemonBridge({ url: 'ws://127.0.0.1:9090', connection: { transports: [server.factory] } })
    const ready = bridge.connect()
    server.advertise([{ cap: 'kv.get', permission: true }])
    await ready
    await expect(bridge.request('file:get')).rejects.toMatchObject({ code: 'ERR_DAEMON_UNSUPPORTED' })
  })

  it('forwards events by capability', async () => {
    const server = new FakeServer()
    const bridge = new DaemonBridge({ url: 'ws://127.0.0.1:9090', connection: { transports: [server.factory] } })
    const ready = bridge.connect()
    server.advertise([{ cap: 'watch', permission: true }])
    await ready

    const seen: unknown[] = []
    const off = bridge.onEvent('watch', (data) => seen.push(data))
    server.last().receive(JSON.stringify({ type: 'event', protocolVersion: 1, cap: 'watch', data: { n: 1 } }))
    server.last().receive(JSON.stringify({ type: 'event', protocolVersion: 1, cap: 'watch', data: { n: 2 } }))
    off()
    server.last().receive(JSON.stringify({ type: 'event', protocolVersion: 1, cap: 'watch', data: { n: 3 } }))
    expect(seen).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('dispatches local capability proxies via proxyRequest', async () => {
    const bridge = new DaemonBridge({ url: 'ws://127.0.0.1:9090', connection: { transports: [neverConnects()] } })
    bridge.onRequest('local.add', (data: { a: number; b: number } | undefined) => (data?.a ?? 0) + (data?.b ?? 0))
    await expect(bridge.proxyRequest('local.add', { a: 2, b: 3 })).resolves.toBe(5)
    await expect(bridge.proxyRequest('local.missing')).rejects.toMatchObject({ code: 'ERR_DAEMON_NOT_FOUND' })
  })
})

describe('GrantGate (M3.3)', () => {
  it('requires a user gesture to grant; grants are session-scoped', () => {
    const idle = new GrantGate({ gestureSource: () => false })
    let thrown: unknown
    try {
      idle.grant('serial:open')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ code: 'ERR_PERMISSION_DENIED' })
    expect(idle.isGranted('serial:open')).toBe(false)

    const active = new GrantGate({ gestureSource: () => true })
    active.grant('serial:open')
    expect(active.isGranted('serial:open')).toBe(true)
    active.revokeAll()
    expect(active.isGranted('serial:open')).toBe(false)
  })
})

describe('capability registry (M3.3)', () => {
  it('describes the §5.4.6 table', () => {
    expect(DAEMON_REGISTRY.length).toBe(10)
    expect(describeCapability('serial:open')?.permission).toBe(true)
    expect(describeCapability('serial:read')?.errors).toContain('ERR_PERMISSION_DENIED')
    expect(describeCapability('sys:stats')?.permission).toBe(false)
    expect(describeCapability('file:watch')?.errors).toContain('ERR_FILE_NOT_FOUND')
    expect(describeCapability('file:get')?.permission).toBe(false)
    expect(describeCapability('nope')).toBeUndefined()
  })

  it('base64 helpers round-trip bytes without Buffer', () => {
    expect(encodeBytes(new Uint8Array([104, 105]))).toBe('aGk=')
    const bytes = new Uint8Array([0, 1, 2, 250, 251, 252, 253, 254, 255])
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes)
  })
})

describe('DaemonBridge grant gating (M3.3)', () => {
  it('rejects permission-gated caps until granted; permissionless caps pass through', async () => {
    const server = new FakeServer()
    const bridge = new DaemonBridge({
      url: 'ws://127.0.0.1:9090',
      connection: { transports: [server.factory] },
      gestureSource: () => false,
    })
    const ready = bridge.connect()
    server.advertise([{ cap: 'serial:read', permission: true }, { cap: 'sys:stats', permission: false }])
    await ready

    await expect(bridge.request('serial:read')).rejects.toMatchObject({ code: 'ERR_PERMISSION_DENIED' })
    expect(bridge.requiresGrant('serial:read')).toBe(true)
    expect(bridge.requiresGrant('sys:stats')).toBe(false)
    let thrown: unknown
    try {
      bridge.grant('serial:read')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ code: 'ERR_PERMISSION_DENIED' })

    const p = bridge.request<{ cpu: number; mem: number; uptimeMs: number }>('sys:stats')
    const frame = JSON.parse(server.last().sent.at(-1) ?? '') as { id: string }
    server
      .last()
      .receive(JSON.stringify({ type: 'response', protocolVersion: 1, id: frame.id, cap: 'sys:stats', ok: true, data: { cpu: 1, mem: 2, uptimeMs: 3 } }))
    await expect(p).resolves.toEqual({ cpu: 1, mem: 2, uptimeMs: 3 })
  })

  it('unlocks the typed surface after a gesture-grant', async () => {
    const server = new FakeServer()
    const bridge = new DaemonBridge({
      url: 'ws://127.0.0.1:9090',
      connection: { transports: [server.factory] },
      gestureSource: () => true,
    })
    const ready = bridge.connect()
    server.advertise([{ cap: 'serial:read', permission: true }])
    await ready

    bridge.grant('serial:read')
    expect(bridge.isGranted('serial:read')).toBe(true)

    const p = bridge.serial.read('h1', 5)
    const frame = JSON.parse(server.last().sent.at(-1) ?? '') as { id: string; cap: string }
    expect(frame.cap).toBe('serial:read')
    server.last().receive(JSON.stringify({ type: 'response', protocolVersion: 1, id: frame.id, cap: 'serial:read', ok: true, data: { bytes: 'aGk=' } }))
    await expect(p).resolves.toEqual({ bytes: 'aGk=' })
  })

  it('grant() rejects unadvertised capabilities', async () => {
    const server = new FakeServer()
    const bridge = new DaemonBridge({ url: 'ws://127.0.0.1:9090', connection: { transports: [server.factory] }, gestureSource: () => true })
    const ready = bridge.connect()
    server.advertise([{ cap: 'sys:stats', permission: false }])
    await ready
    let thrown: unknown
    try {
      bridge.grant('serial:open')
    } catch (err) {
      thrown = err
    }
    expect(thrown).toMatchObject({ code: 'ERR_DAEMON_UNSUPPORTED' })
  })
})