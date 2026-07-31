const BASE_BACKOFF_MS = 30_000
const DEFAULT_MULTIPLIER = 2
const DEFAULT_MAX_BACKOFF_MS = 3_600_000
const MAX_ATTEMPTS = 5

export interface BackoffOptions {
  multiplier?: number
  maxBackoffMs?: number
}

export function nextRetryDelayMs(attempts: number, options: BackoffOptions = {}): number {
  const multiplier = options.multiplier ?? DEFAULT_MULTIPLIER
  const max = options.maxBackoffMs ?? DEFAULT_MAX_BACKOFF_MS
  if (attempts < 1) return BASE_BACKOFF_MS
  const delay = BASE_BACKOFF_MS * Math.pow(multiplier, attempts - 1)
  return Math.min(delay, max)
}

export function isDeadLetter(attempts: number): boolean {
  return attempts >= MAX_ATTEMPTS
}

export const MAX_ATTEMPTS_BEFORE_DEAD_LETTER = MAX_ATTEMPTS
