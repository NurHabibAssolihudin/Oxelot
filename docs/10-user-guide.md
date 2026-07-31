# 10. User Guide (For Developer Consumers)

**Chapter status:** Final (v0.1.0) · **File:** `docs/10-user-guide.md`

Audience: frontend/PWA developers who consume `@oxelot/core` / `@oxelot/react`. This chapter answers "how do I use it?" — not "how is it built?" (see Chapters 5 and 9 for internals).

---

## 10.1 Install

```bash
npm install @oxelot/core @oxelot/react
```

- `@oxelot/react` re-exports everything from `@oxelot/core`, so React users can import either package.
- **No other dependencies are required.** Oxelot brings its own worker + WASM loader.

### 10.1.1 React version compatibility
- Requires React ≥ 18 (uses `useSyncExternalStore`). React 19 supported.

---

## 10.2 Initialize Oxelot

### React (one-time, app root)

```tsx
import { useOxelot } from '@oxelot/react'

function App() {
  const oxelot = useOxelot({
    workers: 2,
    dbName: 'catalog.db',
    storageBackend: 'auto',
    sync: { serverUrl: 'https://api.example.com/v1/sync' },
    registerSW: true,
  })
  if (!oxelot) return <SplashScreen />   // useOxelot returns null until ready
  return <MainScreen oxelot={oxelot} />
}
```

- `useOxelot` calls `Oxelot.init()` once (StrictMode-safe), returns the facade, and disposes it on unmount.
- Until `init` resolves, the hook returns `null`; render a splash.

### Vanilla JS / any framework

```ts
import { Oxelot } from '@oxelot/core'

const oxelot = await Oxelot.init({
  dbName: 'catalog.db',
  sync: { serverUrl: 'https://api.example.com/v1/sync' },
})

oxelot.on((ev) => {
  if (ev.type === 'ready') console.log('Oxelot ready')
})
```

---

## 10.3 Core workflows (normative snippets)

### 10.3.1 Offline data write (`useOxelotStorage`)

```tsx
import { useOxelotStorage } from '@oxelot/react'

type Inventory = Record<string, number>

function InventoryEditor() {
  const { data, write, remove, loading, error } = useOxelotStorage<Inventory>('inventory')

  const save = async () => {
    // Optimistic: UI updates immediately; write is durable+queued for sync.
    await write({ ...(data ?? {}), 'SKU-001': 42 })
  }

  if (loading) return <Spinner />
  if (error) return <p role="alert">Failed: {error.code}</p>
  return <button onClick={save}>Save locally</button>
}
```

Behavior contract (§6.3):
- `write` resolves after durable persistence (via worker); local state updates immediately.
- If the device is offline, the mutation is queued as an `OxelotMutation` and delivered later (below).
- `remove` deletes the key.

### 10.3.2 Structured queries (`useOxelotDB`)

```tsx
import { useOxelotDB } from '@oxelot/react'

function LowStock() {
  const { result, loading, error, refresh } = useOxelotDB(
    (db) => db.query<{ sku: string; qty: number }>('SELECT sku, qty FROM products WHERE qty < ?', [10]),
  )
  if (loading) return <Spinner />
  return (
    <>
      <ul>{result?.map((r) => <li key={r.sku}>{r.sku}: {r.qty}</li>)}</ul>
      <button onClick={refresh}>Refresh</button>
    </>
  )
}
```

- `useOxelotDB` runs the query in a worker; the main thread never blocks.
- Re-runs when `deps` change; `refresh()` forces a re-run.

### 10.3.3 Background sync (status + manual flush)

```tsx
import { useOxelotSyncStatus } from '@oxelot/react'

function SyncBadge() {
  const { state, pending, deadLetters, flush } = useOxelotSyncStatus()
  const label = {
    idle: 'In sync',
    queued: `${pending} pending`,
    syncing: 'Syncing…',
    dead_letter: `${deadLetters} failed`,
  }[state.kind]
  return (
    <button onClick={flush} disabled={state.kind === 'syncing'}>
      {label}
    </button>
  )
}
```

### 10.3.4 Direct facade access (any framework)

```ts
import { Oxelot } from '@oxelot/core'

const oxelot = await Oxelot.init({ dbName: 'catalog.db' })

// Raw file access (OPFS/IndexedDB, abstracted)
const file = await oxelot.storage.open('photos.bin', 'readwrite')
await file.writeBytes(0, new Uint8Array([1, 2, 3]))
await file.sync()
await file.close()

// SQL via WASM SQLite
await oxelot.db.run('CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, total REAL)')
await oxelot.db.run('INSERT INTO orders (id, total) VALUES (?, ?)', ['o-123', 9.99])
const row = await oxelot.db.exec('SELECT * FROM orders WHERE id = ?', ['o-123'])

// Enqueue a mutation for background sync
await oxelot.sync.enqueue({
  id: crypto.randomUUID(),
  schemaVersion: 1,
  collection: 'orders',
  op: 'upsert',
  payload: { id: 'o-123', total: 9.99 },
  createdAt: Date.now(),
  attempts: 0,
})

// Subscribe to events
oxelot.on((ev) => {
  switch (ev.type) {
    case 'sync-state': /* ev.state.kind */ break
    case 'storage-change': /* ev.key, ev.sourceTab */ break
    case 'worker-error': /* ev.message */ break
  }
})

// Clean up when leaving
await oxelot.dispose()
```

### 10.3.5 Hardware capability check

```ts
const caps = await oxelot.hardware.capabilities()
if (caps.nfc) {
  await oxelot.hardware.acquire('nfc') // triggers user prompt
}
```

---

## 10.4 Using core without React (adapter pattern)

```ts
import { Oxelot } from '@oxelot/core'

// Plain reactive wrapper example (framework-agnostic)
export function createOxelotStore(config) {
  const state = { ready: false, sync: null }
  const listeners = new Set<() => void>()
  let oxelot: Oxelot

  const emit = () => listeners.forEach((l) => l())
  const subscribe = (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }

  Oxelot.init(config).then((o) => {
    oxelot = o
    state.ready = true
    o.on((ev) => { if (ev.type === 'sync-state') state.sync = ev.state; emit() })
    emit()
  })

  return {
    get ready() { return state.ready },
    get sync() { return state.sync },
    get core() { return oxelot },
    subscribe,
  }
}
```

---

## 10.5 Consumer distribution checklist (must all be true)

1. **HTTPS** everywhere (localhost is exempt). Required for OPFS, Service Worker, Wake Lock, and all Fugu APIs.
2. **PWA manifest** with `"display": "standalone"` and `start_url` → enables install (A2HS).
3. **Service worker registered** (either `registerSW: true` in `Oxelot.init` or the consumer's own SW that listens for `sync` events and calls `oxelot.sync.flush()`).
4. **Sync endpoint** implements the contract: accepts `POST { schemaVersion, id, collection, op, payload }`, responds `2xx` on success, `4xx` for permanent failures, `5xx`/`429` for retryable failures (Chapter 5 §5.2.4).
5. **Idempotency by `id`:** your server must ignore duplicate `id`s — Oxelot may redeliver after a crash.
6. **No app store required.** Ship the URL.

### Minimal service worker sync handler (consumer-owned)

```js
self.addEventListener('sync', (event) => {
  if (event.tag === 'oxelot-sync') {
    event.waitUntil(self.__oxelot?.sync.flush())
  }
})
```

---

## 10.6 Fallbacks & known limitations

| Scenario | Behavior |
|----------|----------|
| Browser without OPFS (Safari < 15.2) | `storageBackend: 'auto'` selects IndexedDB; all APIs still work |
| No Background Sync support | Flush is attempted on `online` event + next app open |
| `registerSW: false` | Consumer owns SW registration; sync still works via explicit `flush()` |
| Fugu API unavailable (e.g., Web NFC) | `capabilities()` reports `false`; `acquire` rejects `ERR_HW_UNSUPPORTED` |
| Quota exceeded | Writes reject `ERR_QUOTA_EXCEEDED`; the hook surfaces it as `error` |
| Daemon (Phase 3) absent | Everything in Phases 1–2 works unchanged |

---

## 10.7 Error handling cheat-sheet

```ts
try {
  await oxelot.db.query('SELECT * FROM missing')
} catch (e) {
  if (e?.code === 'ERR_FILE_NOT_FOUND') /* create schema first */
  else /* e.code from §5.6 */
}
```

All errors are `OxelotError` with `code` (Chapter 5 §5.6) and `message`. React hooks expose `error` with the same shape.

---

## 10.8 Chapter cross-references
- API contracts: [Chapter 5](05-core-modules-and-specs.md)
- Threading guarantees behind the hooks: [Chapter 6](06-state-management-threading.md)
- Error codes: [Chapter 5 §5.6](05-core-modules-and-specs.md)
