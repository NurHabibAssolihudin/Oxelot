import { describe, it, expect } from 'vitest'
import { OxelotError, oxError, toOxelotError } from '../src/errors'

describe('errors', () => {
  it('constructs an OxelotError with a code', () => {
    const e = oxError('ERR_FILE_NOT_FOUND', 'missing')
    expect(e).toBeInstanceOf(Error)
    expect(e).toBeInstanceOf(OxelotError)
    expect(e.code).toBe('ERR_FILE_NOT_FOUND')
    expect(e.message).toBe('missing')
  })

  it('passes through existing OxelotErrors', () => {
    const e = oxError('ERR_OPFS_MAIN_THREAD', 'nope')
    expect(toOxelotError(e)).toBe(e)
  })

  it('wraps plain errors as ERR_UNKNOWN', () => {
    const e = toOxelotError(new Error('boom'))
    expect(e).toBeInstanceOf(OxelotError)
    expect(e.code).toBe('ERR_UNKNOWN')
    expect(e.cause).toBeInstanceOf(Error)
  })
})
