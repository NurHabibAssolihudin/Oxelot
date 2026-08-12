import { createHash } from 'node:crypto'
import type { Server } from 'node:http'
import { createServer } from 'node:http'
import type { Duplex } from 'node:stream'
import type { IncomingMessage } from 'node:http'

/**
 * Minimal RFC 6455 WebSocket server used as a fake oxelot daemon (§5.4) in
 * Playwright. Implements the full client→server frame path (masked text frames)
 * and the server→client path (unmasked), plus the daemon's handshake and the
 * v1 capability protocol:
 *
 * - `hello` → `advertise` (caps: `echo`, `sys:stats`, `file:get`, `file:set`)
 * - `request` over `echo` / `sys:stats` / `file:*` → `response`
 * - unknown capability → `response` with `ERR_DAEMON_NOT_FOUND`
 * - `ping` → `pong`
 * - local-origin gate on the WebSocket `Origin` header (§5.4.5)
 */

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i

interface Frame {
  opcode: number
  payload: Buffer
}

function encodeFrame(opcode: number, payload: Buffer | string): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload
  const len = data.length
  let header: Buffer
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len])
  } else if (len < 65_536) {
    header = Buffer.alloc(4)
    header[0] = 0x80 | opcode
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x80 | opcode
    header[1] = 127
    header.writeBigUInt64BE(BigInt(len), 2)
  }
  return Buffer.concat([header, data])
}

function sendJson(socket: Duplex, obj: unknown): void {
  socket.write(encodeFrame(0x1, JSON.stringify(obj)))
}

/** Consume as many complete frames as `buffer` holds; return leftovers. */
function tryParseFrames(buffer: Buffer): { frames: Frame[]; rest: Buffer } {
  const frames: Frame[] = []
  let offset = 0
  for (;;) {
    if (buffer.length - offset < 2) break
    const b0 = buffer[offset]
    const b1 = buffer[offset + 1]
    const opcode = b0 & 0x0f
    const masked = (b1 & 0x80) !== 0
    let len = b1 & 0x7f
    let headerLen = 2
    if (len === 126) {
      if (buffer.length - offset < 4) break
      len = buffer.readUInt16BE(offset + 2)
      headerLen = 4
    } else if (len === 127) {
      if (buffer.length - offset < 10) break
      len = Number(buffer.readBigUInt64BE(offset + 2))
      headerLen = 10
    }
    const maskLen = masked ? 4 : 0
    if (buffer.length - offset < headerLen + maskLen + len) break
    const payload = Buffer.from(buffer.subarray(offset + headerLen + maskLen, offset + headerLen + maskLen + len))
    if (masked) {
      const key = buffer.subarray(offset + headerLen, offset + headerLen + maskLen)
      for (let i = 0; i < payload.length; i++) payload[i] ^= key[i % 4]
    }
    frames.push({ opcode, payload })
    offset += headerLen + maskLen + len
  }
  return { frames, rest: Buffer.from(buffer.subarray(offset)) }
}

export interface DaemonEchoServer {
  url: string
  /** Frames received from the client, in arrival order. */
  log: string[]
  close(): Promise<void>
}

export async function startDaemonEchoServer(): Promise<DaemonEchoServer> {
  const log: string[] = []
  const sockets = new Set<Duplex>()
  // M3.2 file-cap store backs the `file:get`/`file:set` handoff path.
  const store = new Map<string, unknown>()

  const server: Server = createServer()

  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const origin = req.headers.origin
    if (origin !== undefined && !LOCAL_ORIGIN.test(origin)) {
      socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
      socket.end()
      return
    }
    const key = req.headers['sec-websocket-key']
    if (typeof key !== 'string') {
      socket.destroy()
      return
    }
    const accept = createHash('sha1')
      .update(key + WS_GUID)
      .digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    sockets.add(socket)
    let buffer = head
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      const parsed = tryParseFrames(buffer)
      buffer = parsed.rest
      for (const frame of parsed.frames) {
        if (frame.opcode === 0x8) {
          socket.end(encodeFrame(0x8, Buffer.alloc(0)))
          socket.destroy()
          return
        }
        if (frame.opcode === 0x9) {
          socket.write(encodeFrame(0xa, frame.payload))
          continue
        }
        if (frame.opcode !== 0x1) continue
        log.push(frame.payload.toString('utf8'))
        dispatch(socket, frame.payload.toString('utf8'), store)
      }
    })
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => sockets.delete(socket))
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('daemon server failed to bind')
  const url = `ws://127.0.0.1:${address.port}`

  return {
    url,
    log,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy()
        sockets.clear()
        server.close(() => resolve())
      }),
  }
}

function dispatch(socket: Duplex, text: string, store: Map<string, unknown>): void {
  let msg: { type?: string; id?: unknown; cap?: unknown; data?: unknown }
  try {
    msg = JSON.parse(text) as { type?: string; id?: unknown; cap?: unknown; data?: unknown }
  } catch {
    return
  }
  switch (msg.type) {
    case 'hello':
      sendJson(socket, {
        type: 'advertise',
        protocolVersion: 1,
        caps: [
          { cap: 'echo', permission: false },
          { cap: 'sys:stats', permission: false },
          { cap: 'serial:list', permission: false },
          { cap: 'serial:read', permission: true },
          { cap: 'file:get', permission: false },
          { cap: 'file:set', permission: false },
          { cap: 'boom', permission: false },
        ],
      })
      return
    case 'ping':
      sendJson(socket, { type: 'pong' })
      return
    case 'request': {
      const cap = typeof msg.cap === 'string' ? msg.cap : ''
      const id = msg.id
      if (cap === 'echo') {
        sendJson(socket, { type: 'response', protocolVersion: 1, id, cap, ok: true, data: { echo: msg.data ?? null } })
        return
      }
      if (cap === 'sys:stats') {
        sendJson(socket, { type: 'response', protocolVersion: 1, id, cap, ok: true, data: { cpu: 12, mem: 34 } })
        return
      }
      if (cap === 'serial:list') {
        sendJson(socket, {
          type: 'response',
          protocolVersion: 1,
          id,
          cap,
          ok: true,
          data: [{ path: '/dev/ttyUSB0', vendorId: '1a86', productId: '7523' }],
        })
        return
      }
      if (cap === 'serial:read') {
        sendJson(socket, { type: 'response', protocolVersion: 1, id, cap, ok: true, data: { bytes: 'aGVsbG8=' } })
        return
      }
      if (cap === 'file:get') {
        const key = (msg.data as { key?: unknown } | undefined)?.key
        if (typeof key !== 'string') {
          sendJson(socket, { type: 'response', protocolVersion: 1, id, cap, ok: false, error: { code: 'ERR_DAEMON_SCHEMA', message: 'file:get requires a string key' } })
          return
        }
        sendJson(socket, { type: 'response', protocolVersion: 1, id, cap, ok: true, data: store.get(key) ?? null })
        return
      }
      if (cap === 'file:set') {
        const data = msg.data as { key?: unknown; value?: unknown } | undefined
        if (typeof data?.key !== 'string') {
          sendJson(socket, { type: 'response', protocolVersion: 1, id, cap, ok: false, error: { code: 'ERR_DAEMON_SCHEMA', message: 'file:set requires a string key' } })
          return
        }
        store.set(data.key, data.value)
        sendJson(socket, { type: 'response', protocolVersion: 1, id, cap, ok: true, data: { stored: true } })
        return
      }
      sendJson(socket, {
        type: 'response',
        protocolVersion: 1,
        id,
        cap,
        ok: false,
        error: { code: 'ERR_DAEMON_NOT_FOUND', message: `unknown capability ${JSON.stringify(cap)}` },
      })
      return
    }
    default:
      return
  }
}