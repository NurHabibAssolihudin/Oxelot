import type { DaemonSocket, DaemonTransportFactory } from './types'

interface WebSocketLike {
  onopen?: (() => void) | null
  onmessage?: ((ev: { data: unknown }) => void) | null
  onclose?: (() => void) | null
  onerror?: (() => void) | null
  send(data: string): void
  close(): void
}

function wsCtor(): (new (url: string) => WebSocketLike) | undefined {
  const globalScope = globalThis as unknown as { WebSocket?: new (url: string) => WebSocketLike }
  return typeof globalScope.WebSocket === 'function' ? globalScope.WebSocket : undefined
}

const noopSocket: DaemonSocket = { closed: true, send() {}, close() {} }

/**
 * Primary transport (§5.4.2): `ws://127.0.0.1:<port>`. Uses the standard
 * `WebSocket` global when present (browser + Node ≥ 22); otherwise the open
 * attempt fails fast and the connection moves to the next transport.
 */
export const wsFactory: DaemonTransportFactory = {
  kind: 'websocket',
  open(url, handlers) {
    const Ctor = wsCtor()
    if (!Ctor) {
      queueMicrotask(() => handlers.onClose(new Error('WebSocket is unavailable in this environment')))
      return noopSocket
    }
    let ws: WebSocketLike | null
    try {
      ws = new Ctor(url)
    } catch (err) {
      queueMicrotask(() => handlers.onClose(err instanceof Error ? err : new Error(String(err))))
      return noopSocket
    }
    // The browser WebSocket only accepts sends once OPEN, but the connection
    // issues its `hello` synchronously after `open()` returns. Buffer outgoing
    // frames until `onopen` and flush them there.
    let ready = false
    const outbox: string[] = []
    ws.onopen = () => {
      ready = true
      for (const frame of outbox) ws.send(frame)
      outbox.length = 0
    }
    ws.onmessage = (ev) => handlers.onMessage(String(ev.data))
    ws.onclose = () => handlers.onClose()
    ws.onerror = () => {
      // `error` is always followed by `close`; the connection treats the close as the failure.
    }
    return {
      closed: false,
      send: (data) => {
        if (ready) ws.send(data)
        else outbox.push(data)
      },
      close: () => {
        ws.onopen = null
        ws.onmessage = null
        ws.onerror = null
        ws.close()
      },
    }
  },
}

/**
 * Fallback transport (§5.4.2). A DataChannel needs a manual signaling handshake
 * that a real daemon distribution provides (§5.4.1). Until that ships (M3.3+),
 * the attempt fails fast here so the state-machine fallback path is real and
 * testable without a native peer.
 */
export const rtcFactory: DaemonTransportFactory = {
  kind: 'webrtc-datachannel',
  open(_url, handlers) {
    const globalScope = globalThis as unknown as { RTCPeerConnection?: unknown }
    if (typeof globalScope.RTCPeerConnection !== 'function') {
      queueMicrotask(() => handlers.onClose(new Error('WebRTC is unavailable in this environment')))
      return noopSocket
    }
    queueMicrotask(() =>
      handlers.onClose(new Error('WebRTC DataChannel fallback requires a manual signaling handshake (M3.3)')),
    )
    return noopSocket
  },
}