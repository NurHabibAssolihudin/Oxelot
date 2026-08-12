import { oxError } from '../../errors'

/** Reports whether the current task runs inside a user gesture (§5.4.5 point 4). */
export type GestureSource = () => boolean

function defaultGestureSource(): boolean {
  const nav = (globalThis as unknown as { navigator?: { userActivation?: { isActive?: boolean } } }).navigator
  return nav?.userActivation?.isActive === true
}

export interface GrantGateOptions {
  /** Gesture detector; defaults to `navigator.userActivation.isActive`. Testable by injection. */
  gestureSource?: GestureSource
}

/**
 * Session-scoped, gesture-gated permission store (§5.4.5 point 4). A capability
 * advertised with `permission: true` is honoured only after the consumer calls
 * `grant(cap)` from a user-gesture context; otherwise capability calls reject
 * `ERR_PERMISSION_DENIED` and never reach the daemon. Grants are session-scoped
 * (a fresh bridge has an empty gate), matching the ADR-07 "page reload
 * re-prompts" contract.
 */
export class GrantGate {
  private readonly granted = new Set<string>()
  private readonly gestureSource: GestureSource

  constructor(opts: GrantGateOptions = {}) {
    this.gestureSource = opts.gestureSource ?? defaultGestureSource
  }

  isGranted(cap: string): boolean {
    return this.granted.has(cap)
  }

  /** Grant `cap` for this session. Requires an active user gesture; otherwise `ERR_PERMISSION_DENIED`. */
  grant(cap: string): void {
    if (!this.gestureSource()) {
      throw oxError('ERR_PERMISSION_DENIED', `granting capability ${JSON.stringify(cap)} requires a user gesture`)
    }
    this.granted.add(cap)
  }

  revokeAll(): void {
    this.granted.clear()
  }
}