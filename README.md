# Oxelot — Open-Source Low-Level PWA Native-Bridge Library

> **Package:** `@oxelot/core` · **Companion:** `@oxelot/react` · **Status:** Specification v0.1.0 (Draft) · **License:** [MIT](LICENSE)

Oxelot is a high-performance, low-level PWA native-bridge library. It is **not** a web framework, **not** a UI component library, and **not** a DOM engine. It is a bridge that lets Progressive Web Apps reach native-level storage, background processing, and hardware access while remaining distributed over the open web — bypassing app-store gates such as Google Play's 14-day closed-testing rule and sideloading verification.

---

## Documentation Index (Single Source of Truth)

This repository contains the complete, executable specification for Oxelot. Read in order. Each document is self-contained but references its predecessors; no document assumes knowledge from outside this suite.

| # | Document | Content | Audience |
|---|----------|---------|----------|
| 1 | [`docs/01-project-overview.md`](docs/01-project-overview.md) | Identity, problem statement, measurable goals, consumer personas | Everyone |
| 2 | [`docs/02-planning-roadmap.md`](docs/02-planning-roadmap.md) | Phase 1–3 milestones, task breakdown, exit criteria, execution strategy | Maintainers, PMs |
| 3 | [`docs/03-tech-stack-architecture.md`](docs/03-tech-stack-architecture.md) | Languages, architecture patterns, storage layer, ecosystem/tooling, system diagram | Architects, implementers |
| 4 | [`docs/04-ADR/`](docs/04-ADR/README.md) | Three Architecture Decision Records with rationale + consequences | Architects |
| 5 | [`docs/05-core-modules-and-specs.md`](docs/05-core-modules-and-specs.md) | `/storage`, `/sync`, `/hardware`; full TypeScript API contracts; React Hooks | Implementers, library consumers |
| 6 | [`docs/06-state-management-threading.md`](docs/06-state-management-threading.md) | Message protocol, threading topology, offline-first sync flow | Implementers |
| 7 | [`docs/07-boundaries-constraints.md`](docs/07-boundaries-constraints.md) | Strict anti-patterns (no DOM, no framework lock-in), performance budget | All contributors |
| 8 | [`docs/08-developer-guide.md`](docs/08-developer-guide.md) | Environment prerequisites, project tree, tooling setup, testing strategy | Contributors |
| 9 | [`docs/09-implementation-guide.md`](docs/09-implementation-guide.md) | Ordered build steps, file-by-file instructions, worker bridge boilerplate | AI agents, implementers |
| 10 | [`docs/10-user-guide.md`](docs/10-user-guide.md) | Install, initialize, offline writes, background sync, distribution checklist | Frontend developers |

---

## Hard Gates (Non-Negotiable)

These requirements are enforced by CI and are defined precisely in [Chapter 7](docs/07-boundaries-constraints.md) and [Chapter 1 §1.3](docs/01-project-overview.md):

1. **Main-thread long tasks < 16ms.**
2. **Worker message round-trip < 16ms (p95).**
3. **Zero DOM manipulation** in `@oxelot/core`.
4. **Zero framework imports** in `@oxelot/core`.
5. **GB-scale OPFS storage** without quota prompts or eviction.

---

## Quick Start (Summary)

```bash
npm install @oxelot/core @oxelot/react
```

```tsx
import { useOxelot } from '@oxelot/react'

function App() {
  const oxelot = useOxelot({ dbName: 'catalog.db', workers: 2 })
  return null
}
```

Full workflow in [Chapter 10](docs/10-user-guide.md).

---

## Repository Status

- [x] Phase 1 — Foundation & Storage (MVP) `v0.1.0` — **implemented** (unit tests green, G7 bundle gate passing)
- [x] Phase 2 — Hardware & Background Layer `v0.2.0` — **implemented** (M2.1 SW relay, M2.2 durable queue + G4 soak, M2.3 Web Locks, M2.4 periodic sync, M2.5 hardware bridge)
- [x] Stabilization `v0.2.1` — **implemented** (`useOxelotSyncStatus` snapshot fix + queue seeding, `useOxelotStorage.remove` now enqueues a `delete` envelope via `makeStorageMutation(..., { op: 'delete' })`, first React unit-test suite — see docs/11 "Stabilization — v0.2.1")
- [x] Stabilization `v0.2.2` — **implemented** (sync queue O(n) → chunked layout v2: manifest + ≤500-envelope chunks, two-phase compaction, transparent legacy migration; exactly-once/pop-on-success/checkpoint semantics unchanged — see docs/11 "Stabilization — v0.2.2")
- [ ] Phase 3 — Daemon / Advanced Bridge `v0.3.0`

### Phase 2 implementation notes (v0.2.0)

**Implemented:** M2.1 service worker relay (`sw.ts` registered by `Oxelot.init` when `registerSW: true`, `oxelot-sync` message relay, `sync` + `periodicsync` event handlers, shared IndexedDB `oxelot`/`kv` queue), M2.2 durable background-sync queue (envelope write-ahead, atomic pop-on-success, checkpointed drains, exponential backoff 30s→1h cap, dead letters, exactly-once by `id`, G4 100k-soak green in 5.5 m), M2.3 Web Locks (`oxelot-sync` blocking flush serialization — exactly one active flusher across page/tab/SW; `oxelot-storage:<name>` write+read guard; release→sibling `storage-change` invalidation ≤100 ms), M2.4 periodic background sync (`features.periodicSync` with default 12 h min interval, no-op fallback, `syncCapabilities()`), M2.5 Fugu hardware bridge (`capabilities()` truth table on Chromium/WebKit/Firefox, native `acquire()` prompt mapping with `ERR_HW_GESTURE_REQUIRED`/`ERR_HW_DENIED`, wakeLock release handle), D8 optimistic write→envelope (`useOxelotStorage.write` enqueues `storage:<key>` upsert and rolls back via second `storage-change`). 87 unit tests, 21 default e2e green (plus 6-test 3-browser matrix via `PW_MATRIX=1`).

**Pending / manual (documented, not CI-blocking):**

| Item | Status | Spec reference |
|------|--------|----------------|
| Real `sync`/`periodicsync` event firing | headless Chromium disables Background Sync scheduling; CI drives the identical flush path via the `oxelot-sync` relay | Chapter 5 §5.2.7, docs/11 |
| Native hardware permission prompts (USB/NFC/Bluetooth/FSA) | CI covers error-code mapping + truth table; real prompt flows are the manual device matrix | Chapter 5 §5.3.3, Chapter 8 §8.4 |
| Full 3-browser truth table | `PW_MATRIX=1 npx playwright install firefox` then `PW_MATRIX=1 npx playwright test packages/e2e/hardware.spec.ts` (verified locally 6/6) | docs/11 Phase 4 |

### Phase 1 implementation notes (v0.1.0)

**Implemented:** monorepo scaffolding (npm workspaces), `@oxelot/core` (facade, worker pool, OPFS/IndexedDB storage, sync queue + backoff + dead letters, hardware capability detection, error codes), worker config delivery via `op: 'config'` (ADR-04, `dbName`/`storageBackend`/`dbEnabled` honored), WASM SQLite `db.run`/`db.query`/`db.checkpoint` with image-based OPFS persistence across reloads (ADR-05, pinned to one worker, `npm run build:wasm` → `wasm32-wasip1` via zig), cross-tab `storage-change` events via BroadcastChannel (ADR-06, `sourceTab` echo filter, ≤100 ms propagation), `@oxelot/react` hooks (M1.6, shared-instance playground app), dependency-cruiser framework gate (G6), G1 long-task perf gate (30 s workload, nightly CI), G2 OPFS soak (5 MB CI smoke + 500 MB manual `@g2-full`), G7 WASM-ready timing, playground (React), CI workflows, 39 unit tests, bundle-size gate (3.1 KB gzip), Playwright e2e (smoke, G3 round-trip, B-1 no-DOM probe, M1.5 cross-tab propagation, M1.6 hooks, G2 smoke, G7 timing) green on local Chromium.

**Pending / manual (documented, not CI-blocking):**

| Item | Status | Spec reference |
|------|--------|----------------|
| Full OPFS VFS for SQLite (ADR-05 end-state) | interim serialize/deserialize image persistence implemented; byte-level VFS deferred as a larger FFI surface | Chapter 5 §5.1.4 |
| G2 full 500 MB soak | runs manually (`npm run test:g2-full`); CI runs a 5 MB byte-exact smoke (`opfs` tag) due to GitHub Actions time limits | Chapter 2 §2.1 |
| G7 WASM-ready ≤100 ms on mid-tier Android | desktop Chromium bound asserted in e2e; Android is the manual device matrix | Chapter 2 §2.1, Chapter 8 §8.4.4 |

**Tooling deltas vs. spec:** monorepo uses **npm workspaces** (chosen over pnpm; `pnpm` is a drop-in alternative — all commands in Chapters 8/9 are shown as `npm run …`). ESLint uses ESLint 9 flat config without `eslint-plugin-deprecation` (incompatible with ESLint 9). `vite.config.ts` sets `root: 'playground'` + `@vitejs/plugin-react` so `npm run dev` and the Playwright `webServer` serve the React playground (Chapter 8 §8.3.5). `@vitejs/plugin-react@4` is pinned (v6 requires vite 8).

See [Chapter 2](docs/02-planning-roadmap.md) for the gate criteria that flip each checkbox.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, then [Chapter 8](docs/08-developer-guide.md) (setup) and [Chapter 7](docs/07-boundaries-constraints.md) (rules) before opening a PR. All new public APIs require an ADR (see [Chapter 4](docs/04-ADR/README.md)).
