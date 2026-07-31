import type { OxelotMessage } from './bridge'

type Registry = Record<string, (payload: unknown, transfer?: ArrayBuffer[]) => unknown>

function resultIsTransferable(r: unknown): r is ArrayBuffer {
  return r instanceof ArrayBuffer
}

export function handleMessages(registry: Registry): void {
  self.onmessage = async (ev: MessageEvent<OxelotMessage>) => {
    const msg = ev.data
    if (msg.kind !== 'request') return
    try {
      const handler = registry[msg.op]
      if (!handler) throw new Error(`unknown op "${msg.op}"`)
      const result = await handler(msg.payload, msg.transfer)
      if (resultIsTransferable(result)) {
        const reply: OxelotMessage = { kind: 'response', id: msg.id, ok: true, result }
        self.postMessage(reply, { transfer: [result] })
      } else {
        const reply: OxelotMessage = { kind: 'response', id: msg.id, ok: true, result }
        self.postMessage(reply)
      }
    } catch (err) {
      const code = err instanceof Error ? (err as Error & { code?: string }).code ?? 'ERR_UNKNOWN' : 'ERR_UNKNOWN'
      const reply: OxelotMessage = {
        kind: 'response',
        id: msg.id,
        ok: false,
        error: { code, message: err instanceof Error ? err.message : String(err) },
      }
      self.postMessage(reply)
    }
  }
}

export function emitEvent(name: string, payload?: unknown): void {
  const msg: OxelotMessage = { kind: 'event', name, payload }
  self.postMessage(msg)
}
