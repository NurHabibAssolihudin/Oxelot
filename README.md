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
- [ ] Phase 2 — Hardware & Background Layer `v0.2.0`
- [ ] Phase 3 — Daemon / Advanced Bridge `v0.3.0`

### Phase 1 implementation notes (v0.1.0)

**Implemented:** monorepo scaffolding (npm workspaces), `@oxelot/core` (facade, worker pool, OPFS/IndexedDB storage, sync queue + backoff + dead letters, hardware capability detection, error codes), worker config delivery via `op: 'config'` (ADR-04, `dbName`/`storageBackend`/`dbEnabled` honored), WASM SQLite `db.run`/`db.query`/`db.checkpoint` with image-based OPFS persistence across reloads (ADR-05, pinned to one worker, `npm run build:wasm` → `wasm32-wasip1` via zig), `@oxelot/react` hooks, playground, CI workflow, 33 unit tests, bundle-size gate (3.1 KB gzip), Playwright e2e (smoke, G3 round-trip, B-1 no-DOM probe, SQLite persistence across reload) green on local Chromium.

**Pending (blocked on environment, not spec):**

| Item | Blocker | Spec reference |
|------|---------|----------------|
| Full OPFS VFS for SQLite (ADR-05 end-state) | interim serialize/deserialize image persistence implemented; byte-level VFS deferred as a larger FFI surface | Chapter 5 §5.1.4 |
| OPFS 500 MB soak (G2) + long-task gate (G1) | soak/perf specs not yet written; browser runtime now available locally | Chapter 2 §2.1 |

**Tooling deltas vs. spec:** monorepo uses **npm workspaces** (chosen over pnpm; `pnpm` is a drop-in alternative — all commands in Chapters 8/9 are shown as `npm run …`). ESLint uses ESLint 9 flat config without `eslint-plugin-deprecation` (incompatible with ESLint 9). `vite.config.ts` sets `root: 'playground'` so `npm run dev` and the Playwright `webServer` serve the playground (Chapter 8 §8.3.5).

See [Chapter 2](docs/02-planning-roadmap.md) for the gate criteria that flip each checkbox.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) first, then [Chapter 8](docs/08-developer-guide.md) (setup) and [Chapter 7](docs/07-boundaries-constraints.md) (rules) before opening a PR. All new public APIs require an ADR (see [Chapter 4](docs/04-ADR/README.md)).
