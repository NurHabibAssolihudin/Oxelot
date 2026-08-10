import { SYNC_TAG } from './queue'

export const PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000

export interface SyncCapabilities {
  /** One-shot background sync (`registration.sync`) available — the SW drains the shared queue on connectivity restore. */
  backgroundSync: boolean
  /** Periodic background sync (`registration.periodicSync`) available — the SW drains the shared queue on a periodic cadence. */
  periodicSync: boolean
}

interface CapableRegistration {
  sync?: unknown
  periodicSync?: {
    register(tag: string, opts?: { minInterval: number }): Promise<void>
  }
}

async function currentRegistration(): Promise<CapableRegistration | undefined> {
  const nav = (globalThis as unknown as { navigator?: Navigator }).navigator
  if (!nav || !('serviceWorker' in nav)) return undefined
  try {
    const registrations = await nav.serviceWorker.getRegistrations()
    return (registrations[0] ?? undefined) as CapableRegistration | undefined
  } catch {
    return undefined
  }
}

/** Detect background-sync availability. Pass an explicit `registration` for determinism (tests); otherwise the origin's first registration is probed. Never throws — a missing `serviceWorker`/registration degrades to `false`. */
export async function detectSyncCapabilities(registration?: CapableRegistration): Promise<SyncCapabilities> {
  const reg = registration ?? (await currentRegistration())
  return {
    backgroundSync: Boolean(reg?.sync),
    periodicSync: Boolean(reg?.periodicSync),
  }
}

export interface PeriodicSyncOptions {
  /** `features.periodicSync` — `true` uses the default minimum interval; a number is the min-interval in ms. */
  enabled: boolean | number | undefined
  /** Default minimum interval when `enabled === true` (default `PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS`). */
  defaultMinIntervalMs?: number
}

export interface PeriodicSyncResult {
  registered: boolean
  minIntervalMs?: number
  error?: string
}

/**
 * Register the `oxelot-sync` periodic tag (M2.4 slice 4.1). Graceful no-op
 * fallback: a missing `periodicSync` API (Firefox/Safari) or a rejected
 * registration (headless Chromium, no permission, not-installed PWA) never
 * throws and never breaks registration of the app.
 */
export async function registerPeriodicSync(
  registration: CapableRegistration | undefined,
  opts: PeriodicSyncOptions,
): Promise<PeriodicSyncResult> {
  if (!opts.enabled) return { registered: false }
  const api = registration?.periodicSync
  if (!api) return { registered: false }
  const minIntervalMs =
    typeof opts.enabled === 'number' ? opts.enabled : (opts.defaultMinIntervalMs ?? PERIODIC_SYNC_DEFAULT_MIN_INTERVAL_MS)
  try {
    await api.register(SYNC_TAG, { minInterval: minIntervalMs })
    return { registered: true, minIntervalMs }
  } catch (err) {
    return { registered: false, error: err instanceof Error ? err.message : String(err) }
  }
}