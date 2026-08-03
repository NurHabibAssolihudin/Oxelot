export const STORAGE_CHANNEL = 'oxelot-storage'

export interface StorageChangeMessage {
  key: string
  sourceTab: string
}

const TAB_KEY = 'oxelot.tab'

function getSession(): Storage | undefined {
  try {
    return typeof sessionStorage !== 'undefined' ? sessionStorage : undefined
  } catch {
    return undefined
  }
}

/**
 * Stable per-tab identifier, persisted for the lifetime of the tab session so
 * reloads in the same tab keep the same identity (and therefore do not see
 * their own writes as remote changes).
 */
export function getSourceTab(): string {
  const session = getSession()
  const existing = session?.getItem(TAB_KEY)
  if (existing) return existing
  const id = `tab-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  try {
    session?.setItem(TAB_KEY, id)
  } catch {
    // sessionStorage unavailable (privacy mode); fall back to a fresh id.
  }
  return id
}

/**
 * Cross-tab storage event transport. Writes and mutations on this tab are
 * broadcast here so sibling tabs can invalidate caches and re-read. Events from
 * this same tab (echo) are filtered out by the caller via `sourceTab`.
 *
 * Degrades to a no-op when `BroadcastChannel` is unavailable (non-supporting
 * engines, some privacy modes): single-tab behaviour is unaffected.
 */
export class StorageBroadcast {
  private readonly channel: BroadcastChannel | undefined

  constructor(channelName = STORAGE_CHANNEL) {
    if (typeof BroadcastChannel !== 'undefined') {
      this.channel = new BroadcastChannel(channelName)
    }
  }

  /** Post a change notification to every sibling tab. */
  broadcast(message: StorageChangeMessage): void {
    if (!this.channel) return
    try {
      this.channel.postMessage(message)
    } catch {
      // Ignore broadcast failures: single-tab behaviour must not throw.
    }
  }

  /** Subscribe to changes originating from *other* tabs. Returns a disposer. */
  onRemote(cb: (message: StorageChangeMessage) => void): () => void {
    if (!this.channel) return () => undefined
    const handler = (ev: MessageEvent<StorageChangeMessage | undefined>): void => {
      const message = ev.data
      if (typeof message?.key === 'string' && message.sourceTab !== getSourceTab()) {
        cb(message)
      }
    }
    this.channel.addEventListener('message', handler)
    return () => this.channel?.removeEventListener('message', handler)
  }

  /** Close the underlying channel. Idempotent. */
  dispose(): void {
    this.channel?.close()
  }
}
