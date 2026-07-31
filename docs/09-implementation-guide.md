# 9. Implementation Guide (For AI/Human Coders)

**Chapter status:** Final (v0.1.0) · **File:** `docs/09-implementation-guide.md`

This is the **execution blueprint**. It defines the exact file creation order, the normative interfaces to implement (all declared in Chapter 5), and the worker-bridge boilerplate to copy. "Implementation" means *conforming to Chapter 5 contracts* and passing *Chapter 8 tests*.

---

## 9.0 Ground rules for implementers

1. **Implement to the contract, not to the test.** Chapter 5 types are normative; tests verify them. Do not rename fields or types to suit an implementation.
2. **Tests first (TDD).** Each step lists its required test before the code is considered done.
3. **One vertical slice per PR** (Chapter 2 §2.0.2).
4. **Never edit `docs/` to make code "pass".** Docs are the spec; if a spec conflict arises, raise an ADR.

---

## 9.1 File creation order (strict)

Follow this order. Each step's output is consumed by later steps.

| Step | Create | Depends on | Test gate |
|------|--------|-----------|-----------|
| 1 | Root: `package.json` (npm workspaces), `tsconfig.base.json`, `eslint.config.mjs`, `prettier.config.mjs`, `vitest.config.ts`, `playwright.config.ts`, `.gitignore` | — | `npm install` + `npm run lint` green |
| 2 | `packages/core/package.json`, `tsup.config.ts`, `packages/react/package.json` | 1 | `npm run build` produces empty-but-valid dist |
| 3 | `packages/core/src/errors.ts` (§5.6 `OxelotError`) | 2 | unit: every code in §5.6 throws/constructs |
| 4 | `packages/core/src/core/pool/bridge.ts` (§6.2, §9.3 boilerplate) | 3 | unit: request/response/timeout/transfer |
| 5 | `packages/core/src/core/pool/pool.ts` + `worker-entry.ts` | 4 | e2e: round-trip p95 < 16ms |
| 6 | `packages/core/src/core/storage/opfs.ts` (§5.1) | 5 | e2e: write→reload→read (G2) |
| 7 | `packages/core/src/core/storage/idb.ts` (§5.1) | 5 | unit+e2e fallback path |
| 8 | `packages/core/src/core/storage/index.ts` (factory) | 6,7 | unit: selection table |
| 9 | `wasm/` crate (`sqlite-vfs`) → `wasm.ts` loader | 8 | build + `db` smoke test |
| 10 | `packages/core/src/core/db.ts` (`DatabaseFacade`) | 9 | e2e: CRUD + reload persistence |
| 11 | `packages/core/src/core/sync/*` (envelope, queue, scheduler, web-lock) | 5,8 | unit: backoff math; e2e: soak (G4) |
| 12 | `packages/core/src/core/hardware/*` (§5.3) | 5 | unit: capability truth table |
| 13 | `packages/core/src/core/index.ts` (facade, `Oxelot.init`) | 10,11,12 | e2e: `init` → `ready`; no-DOM probe (B-1) |
| 14 | `packages/react/src/hooks.ts` (§5.7) | 13 | e2e: hooks in playground |
| 15 | CI workflow + perf gate + size gate | 1–14 | `npm run test:perf`, `npm run size` |

---

## 9.2 Root scaffolding (Step 1) — minimal normative contents

```jsonc
// package.json (root)
{
  "name": "oxelot",
  "private": true,
  "workspaces": ["packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "dev": "vite --port 5199",
    "build": "npm run build -ws",
    "build:wasm": "cd wasm && wasm-pack build --target web --out-dir ../packages/core/dist/wasm --release",
    "lint": "eslint .",
    "typecheck": "tsc -p packages/core && tsc -p packages/react",
    "test": "vitest run",
    "test:e2e": "playwright test",
    "test:perf": "playwright test --grep @perf",
    "size": "node scripts/size-check.mjs"
  }
}
```

```jsonc
// workspaces field above replaces pnpm-workspace.yaml
```

---

## 9.3 Worker communication bridge (Steps 4–5) — boilerplate (normative)

### 9.3.1 Main-thread bridge

```ts
// packages/core/src/core/pool/bridge.ts
import { oxError, OXELOT_ERR } from '../../errors'

export type OxelotMessage =
  | { kind: 'request'; id: string; op: string; payload?: unknown; transfer?: ArrayBuffer[] }
  | { kind: 'response'; id: string; ok: true; result?: unknown }
  | { kind: 'response'; id: string; ok: false; error: { code: string; message: string } }
  | { kind: 'event'; name: string; payload?: unknown }

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void }

export class OxelotBridge {
  private readonly pending = new Map<string, Pending>()
  private nextId = 0
  private listeners = new Set<(name: string, payload?: unknown) => void>()

  constructor(
    private readonly worker: Worker,
    private readonly timeoutMs = 10_000,
  ) {
    worker.addEventListener('message', (ev: MessageEvent<OxelotMessage>) => {
      const msg = ev.data
      if (msg.kind === 'response') {
        const p = this.pending.get(msg.id)
        if (!p) return
        this.pending.delete(msg.id)
        if (msg.ok) p.resolve(msg.result)
        else p.reject(oxError(msg.error.code, msg.error.message))
      } else if (msg.kind === 'event') {
        for (const cb of this.listeners) cb(msg.name, msg.payload)
      }
    })
  }

  request<T>(op: string, payload?: unknown, transfer: ArrayBuffer[] = []): Promise<T> {
    const id = String(this.nextId++)
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject })
      this.worker.postMessage({ kind: 'request', id, op, payload, transfer }, transfer)
      const t = setTimeout(() => {
        if (this.pending.delete(id)) reject(oxError('ERR_BRIDGE_TIMEOUT', `op "${op}" timed out`))
      }, this.timeoutMs)
      const orig = resolve
      const wrapResolve = (v: unknown) => { clearTimeout(t); orig(v) }
      const wrapReject = (e: Error) => { clearTimeout(t); reject(e) }
      this.pending.set(id, { resolve: wrapResolve, reject: wrapReject })
    })
  }

  onEvent(cb: (name: string, payload?: unknown) => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  get pendingCount() { return this.pending.size }
}
```

> **Note:** the `wrapResolve/wrapReject` pairing is required so the timeout is cleared exactly once. Implementers must keep the timeout-clear logic; tests assert no leaked timers.

### 9.3.2 Worker-side registry

```ts
// packages/core/src/core/pool/worker-handler.ts
import type { OxelotMessage } from './bridge'

type Registry = Record<string, (payload: unknown, transfer?: ArrayBuffer[]) => unknown | Promise<unknown>>

export function handleMessages(registry: Registry): void {
  self.onmessage = async (ev: MessageEvent<OxelotMessage>) => {
    const msg = ev.data
    if (msg.kind !== 'request') return
    try {
      const result = await registry[msg.op]?.(msg.payload)
      const reply: OxelotMessage = { kind: 'response', id: msg.id, ok: true, result }
      self.postMessage(reply, { transfer: resultIsTransferable(result) ? [result] : [] })
    } catch (err) {
      const reply: OxelotMessage = {
        kind: 'response', id: msg.id, ok: false,
        error: { code: err?.code ?? 'ERR_UNKNOWN', message: err instanceof Error ? err.message : String(err) },
      }
      self.postMessage(reply)
    }
  }
}

function resultIsTransferable(r: unknown): r is ArrayBuffer {
  return r instanceof ArrayBuffer
}
```

### 9.3.3 Worker bootstrap (OPFS sync handle lives here)

```ts
// packages/core/worker-entry.ts
import { handleMessages } from './core/pool/worker-handler'

const dir = await navigator.storage.getDirectory()
const handle = await dir.getFileHandle('oxelot.db', { create: true })
const sync = await handle.createSyncAccessHandle()

handleMessages({
  'storage.readBytes': ({ offset, length }) => {
    const buf = new Uint8Array(length)
    const n = sync.read(buf, { at: offset })
    return buf.slice(0, n).buffer        // transferable
  },
  'storage.writeBytes': ({ offset, data }) => sync.write(data, { at: offset }),
  'storage.truncate': ({ size }) => sync.truncate(size),
  'storage.getSize': () => sync.getSize(),
  'storage.flush': () => sync.flush(),
  'storage.close': () => sync.close(),
  'db.exec': (payload) => runSql(payload), // wired to WASM SQLite (Step 9)
})
```

---

## 9.4 Worker-context unit tests (normative harness)

Vitest alone runs in Node's main thread, but the bridge targets `Worker`. The bridge protocol is unit-tested against a **mock `Worker`** that implements `addEventListener`/`postMessage`/`terminate` (`packages/core/test/bridge.test.ts`):

```ts
class MockWorker {
  listeners = new Map<string, ((ev: MessageEvent) => void)[]>()
  posted: { message: OxelotMessage; transfer?: ArrayBuffer[] | undefined }[] = []
  addEventListener(type, cb) { /* … */ }
  postMessage(message, transfer) { this.posted.push({ message, transfer }) }
  respond(response) { /* dispatch to 'message' listeners */ }
  terminate() {}
}
```

Real worker spawn, round-trip timing, and OPFS persistence are e2e (Playwright), since the real OPFS handle and dedicated worker are unavailable in Node.

---

## 9.5 Implementation acceptance checklist per module

- [ ] `bridge.ts`: round-trip works; timeout clears; transfer detaches sender; unknown id ignored.
- [ ] `opfs.ts`: matches §5.1.3 semantics; throws `ERR_OPFS_MAIN_THREAD` on main thread.
- [ ] `idb.ts`: byte-identical results to `opfs.ts` on the same fixture; satisfies `StorageProvider`.
- [ ] `db.ts`: `run/query/exec/checkpoint` against WASM; reload persistence test green.
- [ ] `sync/queue.ts`: `enqueue` durably persists before resolving; `flush` respects backoff; dead letters counted (§5.2.4).
- [ ] `sync/web-lock.ts`: exclusive `oxelot-sync`; `ifAvailable` non-blocking behavior proven in two-context e2e.
- [ ] `hardware/*`: `capabilities()` matches the §5.3.1 truth table per browser profile.
- [ ] `core/index.ts`: `init` → `ready`; `dispose` idempotent; no-DOM probe (B-1) passes.

---

## 9.6 Known pitfalls (documented, avoid)

| Pitfall | Mitigation |
|---------|------------|
| Structured-cloning a large `Uint8Array` across `postMessage` (blows G3) | Always pass buffers via the `transfer` list |
| OPFS sync handle used on the main thread (throws in some engines, silently slow in others) | `createStorage` factory rejects `'opfs'` outside workers (`ERR_OPFS_MAIN_THREAD`) |
| Forgetting `flush()` before `close()` on a sync handle → data loss on crash | Enforce in `OpfsFile.close()`: always `flush()` first |
| Two tabs flushing the queue simultaneously → duplicate delivery | Web Lock `oxelot-sync`, `ifAvailable`, plus consumer-side idempotency by `id` |
| WAL auto-checkpoint never runs → ever-growing `-wal` file | `checkpoint()` exposed; called on `close` and every N flushes |
| SW terminated mid-flush → phantom retries | Envelopes are idempotent by `id`; replay is safe |
| WASM module fetched on app bootstrap → violates G7 | `db` sub-facade lazy-loads; cache the instance |
| Timer leaks in bridge on timeout | Wrap resolve/reject with `clearTimeout` (see §9.3.1 note) |

---

## 9.7 Definition of done (per slice)

1. Contract-conforming implementation (Chapter 5 types unchanged).
2. Unit + worker + e2e tests for the slice green.
3. `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` all green.
4. `npm run test:perf` and `npm run size` green (once wired).
5. No B-1/B-2 violations (ESLint + grep scan).
