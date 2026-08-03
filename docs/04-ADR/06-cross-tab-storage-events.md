# ADR-06 — Cross-Tab Storage Events via BroadcastChannel

## Status
Accepted

## Context

M1.5 (Chapter 2 §2.1) requires storage watcher events: a write in tab A must be observed by tab B within 100 ms so both tabs can invalidate caches and re-read. The event type `storage-change` (Chapter 6 §6.2.1/§6.2.2) and the `Oxelot.on()` subscription API already existed, but **no code ever emitted it** — `useOxelotStorage` (react) subscribes to it but never triggers, and nothing crosses tabs.

Constraints at decision time:

- The wire protocol has exactly three message kinds (`request`, `response`, `event`); worker → main pushes already flow through the `event` kind (§6.2.2) and fan out to `Oxelot.on()` subscribers.
- The worker owns all storage I/O (OPFS sync handles are worker-only). A mutation happens *inside the worker*, so the worker is the natural origin of a `storage-change` notification.
- Sibling tabs need a mechanism that works without shared workers. `BroadcastChannel` is the standard, zero-config cross-tab pipe for same-origin pages; `storage` events (`localStorage`/`sessionStorage`) are too coarse (per-key string, no structured payload, 10 MB cap).
- The tab that wrote must not treat its own echo as a remote change. A stable per-tab identifier is needed to filter echoes.

## Decision

**Emit `storage-change` from the worker over the existing `event` message kind; fan out to the local tab's `Oxelot.on()` subscribers; re-broadcast to sibling tabs via a `BroadcastChannel`; filter echoes by a stable per-tab id (`sourceTab`).**

- **Worker origin:** each mutating op in `worker-entry.ts` (`kv.set`, `storage.writeBytes`, `storage.truncate`, `storage.remove`, `db.run`) calls `emitEvent('storage-change', { key, sourceTab })` after the mutation commits. `emitEvent` already exists in `worker-handler.ts`.
- **sourceTab delivery:** `Oxelot.init` computes `getSourceTab()` (a random id cached in `sessionStorage`, stable per tab session) and sends it to every worker in `op: 'config'` (extended `WorkerInitConfig`, ADR-04) so the worker stamps its notifications. `sessionStorage` is per-tab, so each tab gets a distinct id.
- **Main-thread fan-out (`core/index.ts`):** `pool.onEvent` translates `{type:'event', name:'storage-change', payload:{key,sourceTab}}` into the typed `OxelotEvent` and (a) emits to local subscribers, (b) posts it to the `StorageBroadcast` (`BroadcastChannel('oxelot-storage')`).
- **Remote receipt:** a `StorageBroadcast.onRemote` listener in each `Oxelot` instance receives sibling-tab messages, drops messages whose `sourceTab` equals this tab's id, and emits the typed `storage-change` to local subscribers.
- **Degradation:** when `BroadcastChannel` or `sessionStorage` is unavailable, `StorageBroadcast` is a no-op and `getSourceTab()` falls back to a fresh id — single-tab behaviour is unchanged.
- **Public contract:** `OxelotEvent['storage-change']` carries `key` and `sourceTab` (already declared in Chapter 6). No new public API beyond the `WorkerInitConfig.sourceTab` internal field and the `storage-change` semantics now actually firing.

## Consequences

**Positive (+):**
- `useOxelotStorage` (react) now works as designed: it re-reads on `storage-change` from the same tab or a sibling tab.
- Two-tab propagation is testable and measured: the M1.5 e2e asserts a `storage-change` lands on the sibling tab within 100 ms (wall-clock).
- BroadcastChannel is zero-config, same-origin, structured-clone payloads, and has no 5 MB `localStorage` cap.
- The worker remains the single writer of storage state; the main thread only fans out.

**Negative (−):**
- `BroadcastChannel` is not supported in a few engines/privacy modes; cross-tab propagation silently degrades to none there (single-tab still correct). No fallback polling was added for M1.5.
- `db.run` now emits a `storage-change` for the whole DB image file (`{dbName}.sqlite`) after every mutation — siblings will re-read the image. Acceptable at M1.4/1.5 sizes; revisit with the full VFS (ADR-05 end-state).
- Echo filtering relies on `sourceTab` correctness; a tab that somehow shares a `sessionStorage` (e.g., copy of a browsing session) could suppress its own broadcasts. Edge case, not addressed.

**Neutral (~):**
- `sourceTab` is not a documented public configuration knob; it is derived automatically per tab.
- Events are fire-and-forget (no acknowledgement). Consumers re-read the source of truth on receipt.

## Alternatives considered
- **`localStorage`/`storage` event** — rejected: string-only payloads, per-key granularity, 10 MB cap, and async visibility guarantees that complicate cache invalidation.
- **Shared Worker / BroadcastChannel in the worker** — rejected: deviates from the documented worker→main→`Oxelot.on()` push model and adds a second transport to maintain.
- **IndexedDB watcher / polling** — rejected: slow (transaction events are not cross-tab reliable), and M1.5's 100 ms budget would be at risk.
- **No cross-tab propagation (local only)** — rejected: misses the M1.5 slice entirely.
