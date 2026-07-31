import { describe, it, expect } from 'vitest'
import { nextRetryDelayMs, isDeadLetter, MAX_ATTEMPTS_BEFORE_DEAD_LETTER } from '../src/core/sync/scheduler'

describe('scheduler', () => {
  it('uses 30s base delay for first retry', () => {
    expect(nextRetryDelayMs(1)).toBe(30_000)
  })

  it('backs off exponentially', () => {
    expect(nextRetryDelayMs(2)).toBe(60_000)
    expect(nextRetryDelayMs(3)).toBe(120_000)
  })

  it('caps at maxBackoffMs', () => {
    expect(nextRetryDelayMs(20)).toBe(3_600_000)
    expect(nextRetryDelayMs(20, { maxBackoffMs: 5_000 })).toBe(5_000)
  })

  it('respects custom multiplier', () => {
    expect(nextRetryDelayMs(3, { multiplier: 3 })).toBe(270_000)
  })

  it('dead-letter threshold is exactly MAX_ATTEMPTS_BEFORE_DEAD_LETTER', () => {
    expect(MAX_ATTEMPTS_BEFORE_DEAD_LETTER).toBe(5)
    expect(isDeadLetter(4)).toBe(false)
    expect(isDeadLetter(5)).toBe(true)
  })
})
