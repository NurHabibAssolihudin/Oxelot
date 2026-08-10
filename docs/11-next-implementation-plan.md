# 11. Next Implementation Plan — Phase 0 Hardening + Phase 2 (v0.2.0)

**Chapter status:** Draft (v0.1.1 → v0.2.0) · **File:** `docs/11-next-implementation-plan.md`

This chapter is the **execution plan for the next implementation round**. It records the
gap analysis against the current codebase (as of v0.1.0), then defines ordered slices
(vertical, test-first, one slice per PR per Chapter 2 §2.0). It does **not** redefine any
normative contract in Chapter 5; where a change touches a public surface, an ADR is
required before implementation (Chapter 4, B-4).

---

## 11.1 Gap analysis: planning vs implementation (v0.1.0)

### 11.1.1 Hard gates not yet green

| Gate | Status | Blocker |
|------|--------|---------|
| G2 (500 MB OPFS byte-identical) | Manual only (`@g2-full`); CI runs 5 MB smoke | GitHub Actions time budget; Safari matrix manual |
| G7 (WASM ready ≤ 100 ms, mid-tier Android) | Desktop Chromium only | Device matrix is manual (§8.4.4) |

These are tracked in the README "Pending / manual" table; they do not block Phase 2 work
but must be green before the v0.2.0 release gate.

### 11.1.2 Contract deviations in the current code

| # | Spec (Chapter 5/6) | Current implementation | Severity |
|---|---------------------|------------------------|----------|
| D1 | §6.4 worker crash → respawn + re-dispatch in-flight once | `OxelotPool` only emits `worker-error`; no respawn (`pool/pool.ts:57-59`) | High — requests hang until 10s timeout after a crash |
| D2 | §5.2.5 flush under exclusive `oxelot-sync` Web Lock | `WebLock` class exists but is never used; flush has no lock | High — concurrent tabs double-deliver |
| D3 | §5.2.4 backoff schedule 30s→1m→5m→1h honored between attempts | `flush()` drains everything immediately; `nextRetryDelayMs` unused at runtime | Medium — retries hammer immediately |
| D4 | §5.5.4 `{ type: 'sync-state'; state }` on `Oxelot.on()` | Facade never emits `sync-state`; hooks subscribe directly to `instance.sync` | Medium — public event contract unmet |
| D5 | §6.3.1 auto-flush on connectivity restore | No `online` listener, no SW `sync` listener, no post-enqueue flush | Medium — delivery requires manual `flush()` |
| D6 | §5.6 error table | `ERR_DB_SQL`, `ERR_DB_DISABLED` implemented but absent from the spec table | Low — docs drift |
| D7 | §5.3.3 `acquire()` maps to native permission prompt | `acquire()` only asserts availability; never `ERR_HW_DENIED` | Medium — Phase 2.5 item |
| D8 | §5.7 write → optimistic + envelope enqueue (§6.3.1) | `useOxelotStorage.write` only does `storage.set`; no envelope | Medium — Phase 2 item |
| D9 | M2.1 SW registered by `Oxelot.init` when `registerSW: true` | ✅ resolved by slice 1.1 (v0.1.1); `sw.ts` relay + `sync` listener added by 1.2/1.3; shared queue via 1.4 — all in v0.1.1 | High — was Phase 2 gate |
| D10 | §6.2.4 bridge `pending` load metric | `OxelotBridge` exposes `pendingCount` (see §9.3.1); pool `load()` uses `inFlight` | Info — metric source differs from spec but `load()` is the public one |

### 11.1.3 Phase 2 milestones status

| Milestone | Status | Missing |
|-----------|--------|---------|
| M2.1 SW relay | ✅ | slices 1.1–1.4 (v0.1.1): relay, `sync` listener, shared queue |
| M2.2 Background Sync queue | Partial | `peek` ✅, atomic pop ✅, scheduled backoff ✅, exactly-once dedupe ✅ (slices 1.4/2.1/2.2, v0.1.1); remaining: G4 soak (slice 2.3) |
| M2.3 Web Locks | Stub only | integration into flush + storage writes, lock-release invalidation, 2-context e2e |
| M2.4 Periodic Background Sync | None | `periodicsync` registration + no-op fallback + capability surfacing |
| M2.5 Hardware bridge | Partial | native `acquire()` mapping, permission flow, 3-browser truth table |

---

## 11.2 Execution order (strict, vertical slices)

### Phase 0 — Hardening (foundation for Phase 2) → `v0.1.1`

| Slice | Task | Files | Test gate | Status |
|-------|------|-------|-----------|--------|
| 0.1 | Worker crash respawn + once re-dispatch of in-flight requests | `core/pool/pool.ts`, `core/pool/bridge.ts` | unit: kill worker mid-flight → request resolves/rejects; respawn count asserted | ✅ `pool-crash.test.ts` (4 tests) |
| 0.2 | Web Lock `oxelot-sync` (`ifAvailable`, 30 s) around `flush()` | `core/sync/queue.ts`, `core/sync/web-lock.ts`, `core/index.ts` | unit: lock-held → flush skipped | ✅ `queue.test.ts` (3 tests) |
| 0.3 | Scheduled backoff: `nextRetryAt` persisted on the envelope; flush only delivers due envelopes | `core/sync/envelope.ts`, `core/sync/queue.ts`, `core/sync/scheduler.ts` | unit: exponential 30s→1m→2m→4m… capped at 1h (per existing `nextRetryDelayMs`); due vs not-due selection; `nextRetryAt` survives reload | ✅ `queue.test.ts` (4 tests) |
| 0.4 | Bridge `sync-state` to `Oxelot.on()` (fulfill §5.5.4) | `core/index.ts` | unit: event fan-out | ✅ wired in facade |
| 0.5 | Auto-flush: `online` listener + post-enqueue flush (respecting lock + backoff) | `core/index.ts`, `core/sync/queue.ts` | unit: `online` triggers flush | ✅ `Oxelot.enqueue` + `online` listener |
| 0.6 | Sync §5.6 error table with `ERR_DB_*` codes | `docs/05-core-modules-and-specs.md` | lint + depcruise | ✅ |

### Phase 1 — M2.1 Service Worker relay (needs 0.1–0.5)

| Slice | Task | Files | Gate | Status |
|-------|------|-------|------|--------|
| 1.1 | `Oxelot.init` registers the bundled SW when `registerSW: true` | `core/index.ts`, `sw.ts` | e2e: SW active; idempotent re-register | ✅ `sync-relay.spec.ts` 1.1 |
| 1.2 | Tab↔SW message relay (`type: 'oxelot-sync'` → flush → result to tab) | `sw.ts` | e2e: tab-triggered flush | ✅ `sync-relay.spec.ts` 1.2 |
| 1.3 | SW `sync` event listener → `flush()` | `sw.ts` | e2e: emulated offline→online | ✅ `sync-relay.spec.ts` 1.3 (see caveat below) |
| 1.4 | Envelope queue shared with SW (Cache-API KV already exists) | `sw-kv.ts` | soak 10k | ✅ shared `oxelot`/`kv` store (D9→resolved); soak `sync-relay.spec.ts` 1.4 `@perf` + unit 10k |

**Slice 1.3 caveat:** headless Chromium disables Background Sync even with `grantPermissions(['background-sync'])` and `--enable-features=BackgroundSync` (`registration.sync.register()` throws "Background Sync is disabled"). CI covers the identical flush path by driving `getSync().flush()` via the `oxelot-sync` relay message after an offline→online transition. Real `sync`-event firing is on the manual matrix (Ch. 8 §8.4).

### Phase 2 — M2.2 Durable background sync (parallel with Phase 3)

| Slice | Task | Files | Gate |
|-------|------|-------|------|
| 2.1 | `peek()` + atomic pop-on-success (no double-deliver) | `core/sync/queue.ts` | unit | ✅ `peek()`, pop-on-success, checkpoint persistence `queue.test.ts` |
| 2.2 | Exactly-once by stable `id` (idempotent replay) | `core/sync/*` | unit | ✅ enqueue dedupe by `id` `queue.test.ts` |
| 2.3 | G4 soak: 100k envelopes offline → restore → ≥99% delivered ≤24 h | `packages/e2e/soak.spec.ts` | e2e `@perf` + manual | ⏳ not started |

### Phase 3 — M2.3 Web Locks end-to-end

| Slice | Task | Gate |
|-------|------|------|
| 3.1 | Storage writes (file + KV) under `oxelot-storage:<name>` | unit + e2e two-tab |
| 3.2 | `lockrelease` → cache invalidation in sibling tabs (via `storage-change`) | e2e ≤ 100 ms |
| 3.3 | Contention: two contexts, exactly one active flusher | e2e |

### Phase 4 — M2.4 Periodic sync, then M2.5 Hardware

| Slice | Task | Gate |
|-------|------|------|
| 4.1 | `periodicsync` registration when `features.periodicSync` + supported; no-op fallback | unit + e2e |
| 4.2 | Surface capability to consumers | unit |
| 5.1 | `acquire()` native mapping + `ERR_HW_DENIED`/`ERR_HW_GESTURE_REQUIRED` | unit truth table |
| 5.2 | Truth-table e2e across Chromium/Firefox/WebKit | e2e matrix |

### Release — v0.2.0 (per Chapter 2 §2.5)

1. Freeze API surface; ADR review of every deviation (D1–D10).
2. Full matrix: unit + e2e + perf + size + depcruise + lint.
3. Tag/publish `@oxelot/core` then `@oxelot/react`.
4. Write "Known limitations" appendix.
5. Update README checkboxes.

---

## 11.3 Dependency graph

```
0.1 ─┬─► 0.2 ─► 2.1 ─► 2.2 ─► 2.3        (durable sync)
     ├─► 0.3 ─┘                          (backoff gates delivery)
     ├─► 0.5 ─► 1.1 ─► 1.2 ─► 1.3 ─► 1.4 (SW relay)
     └─► 0.4 ─► 3.1 ─► 3.2 ─► 3.3        (Web Locks e2e)
                    │
                    ▼
              4.1 ─► 4.2 ─► 5.1 ─► 5.2   (periodic + hardware)
```

## 11.4 Definition of done (per slice)

1. Contract-conforming implementation (Chapter 5 types unchanged).
2. Unit/worker/e2e tests for the slice green.
3. `npm run lint`, `npm run depcruise`, `npm run typecheck`, `npm test`, `npm run test:e2e` green.
4. No B-1/B-2 violations.

## 11.5 Normative references

- Roadmap & gates: [Chapter 2](02-planning-roadmap.md)
- API contracts: [Chapter 5](05-core-modules-and-specs.md)
- Threading/message protocol: [Chapter 6](06-state-management-threading.md)
- Rules & performance budget: [Chapter 7](07-boundaries-constraints.md)
- Dev setup & testing: [Chapter 8](08-developer-guide.md)
- Implementation guide: [Chapter 9](09-implementation-guide.md)
