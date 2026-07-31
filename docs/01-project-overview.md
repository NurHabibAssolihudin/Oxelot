# 1. Project Overview & Context

**Chapter status:** Final (v0.1.0) · **File:** `docs/01-project-overview.md` · **Upstream:** README

---

## 1.1 Project Identity

**Oxelot** is a high-performance, low-level PWA native-bridge library published under the scoped packages:

- **`@oxelot/core`** — the framework-agnostic engine (primary artifact, this spec's subject).
- **`@oxelot/react`** — an optional thin React bindings layer.

Oxelot is explicitly **NOT** any of the following:

| Not this | Because |
|----------|---------|
| A web framework | Frameworks own rendering; Oxelot owns data/storage/background/hardware bridging |
| A UI component library | Oxelot never renders DOM nodes or exposes components |
| A DOM engine | Oxelot never touches `document`, `window`, `style`, or layout |
| A bundler / build tool | Oxelot ships as a library consumed by existing bundlers |
| A backend | Oxelot runs entirely client-side; it only relays mutations to the developer's own server |

**One-line definition (use verbatim in any external communication):**

> Oxelot is an open-source, low-level native-bridge library that lets Progressive Web Apps achieve native-level storage throughput, background processing, and hardware access — while remaining distributed over the open web.

---

## 1.2 Problem Statement

Oxelot exists because two independent classes of problems prevent "the open web" from replacing native app distribution: **platform limits on PWAs** and **store gatekeeping on native apps**. Oxelot's job is to dissolve the first so the second becomes irrelevant.

### 1.2.1 Side A — The PWA platform ceiling

A default PWA is subject to hard, browser-enforced limits. These are not marketing numbers; they are the constraints this library is engineered against.

| # | Constraint | Concrete platform reality | Impact |
|---|-----------|---------------------------|--------|
| P1 | **Storage quota & eviction** | Chrome/Edge quota ≈ 60% of free disk but is subject to LRU-based eviction under pressure; Safari uses ~1 GB (soon ~10 GB); private-mode is ephemeral | Cannot trust the browser to durably hold GB-scale offline datasets |
| P2 | **Main-thread blocking** | Rendering, JS, and layout share one thread; a single task > 50ms triggers the browser's Long Task warning, > 16.7ms drops a 60fps frame | Synchronous large DB reads/writes visibly jank the UI |
| P3 | **Background execution limits** | Service workers are terminated after ~30s idle; iOS background wake is opportunistic; no guaranteed timer | Sync, scheduled processing, and retries silently die |
| P4 | **Single-thread compute** | The DOM engine serializes logic on the main thread | Heavy processing (parse, encode, SQL) blocks interaction |
| P5 | **No true file system** | OPFS (2021+) is the first durable, fast FS; File System Access API requires a user gesture per picker | Cannot open a real embedded database file with low-level semantics |
| P6 | **No background hardware I/O** | NFC/USB/Bluetooth require a foreground tab + user activation per operation | Real-world automation impossible in a plain PWA |

### 1.2.2 Side B — The native distribution nightmare

Shipping the same capability as a native app triggers a separate set of obstacles, all of which Oxelot's distribution model avoids entirely:

| Gate | Rule | Oxelot alternative |
|------|------|--------------------|
| Google Play closed testing | ≥ 12 testers must opt-in and remain active for **14 continuous days**; each tester's account must hold the tester link for the full window | Install by URL; no tester pool, no wait window |
| Sideload verification | Play Integrity/Play Protect scans, "unknown app" prompts, possible remote removal of unsigned installs | Signed PWA manifest + HTTPS; install is one tap |
| Apple review | 30–60 day review queues, entitlement arbitration, 30% commission | No review, no commission, immediate rollout |
| Region locks / Play device policy | Enterprise MDM may block sideloads entirely | Web distribution is not blocked by device policy |

**Synthesis:** Oxelot makes the web platform *sufficient* by engineering around P1–P6 so that the native route (and its gates) is unnecessary.

---

## 1.3 Business & Technical Goals (Definition of Success)

Each goal has an **identifier (G#)**, a **metric**, and an **objective acceptance criterion (OAC)**. A goal is "done" only when its OAC is met in CI or in a documented manual test procedure. Chapters 2 and 9 map these to milestones and tests.

| # | Goal | Metric | Objective Acceptance Criterion (OAC) |
|---|------|--------|---------------------------------------|
| G1 | **Smooth UI under load** | Main-thread long task duration | No `Long Task` event > 16ms is emitted during a scripted 30s heavy-write/read workload on a mid-tier Android Chrome device |
| G2 | **GB-scale offline storage** | Sustained writable capacity + durability | A single `OxelotFile` dataset ≥ 500 MB is written, closed, reloaded, and read back byte-identical, without a quota prompt or eviction, on Chromium and Safari 15.2+ |
| G3 | **Worker sync latency** | `postMessage` round-trip (request→response) | p95 < 16ms and max < 32ms for a no-payload round trip, measured with `performance.now()` in both the test harness and the core self-test |
| G4 | **Offline-first durability** | Mutation delivery rate on reconnect | ≥ 99% of queued `OxelotMutation` envelopes delivered exactly once within 24h of connectivity restore (≥ 100k-envelope soak test) |
| G5 | **Zero DOM interference** | Static + runtime checks | ESLint rule + a DOM-free bootstrap probe (see §7 B-1) both pass; grep of published `.js` shows no `document`/`window` identifiers in `@oxelot/core` output |
| G6 | **Framework-agnostic core** | Dependency graph | `@oxelot/core` has zero imports from `react`, `vue`, `svelte`, or any framework in its `dependencies` and in its transpiled output (enforced by a dependency-cruiser test) |
| G7 | **Bundle budget** | Gzipped size + load time | `@oxelot/core` browser build ≤ 35 KB gzip (excluding `.wasm` assets); WASM SQLite module instantiated and ready ≤ 100ms after first request, on mid-tier Android |
| G8 | **Predictable API stability** | Semver discipline | No public API signature change without a new ADR + `minor`/`major` bump; `@oxelot/core` facade is the sole public surface (§7 B-4) |

### 1.3.1 Out of scope (explicitly NOT goals)

These are deliberately excluded to keep the library focused:

- **NO** UI rendering, theming, or layout utilities.
- **NO** offline/online event helpers, networking libraries, or fetch wrappers (except the minimal `sync` relay).
- **NO** state-management framework (Redux/Zustand/Pinia replacement).
- **NO** build-tooling for consumer apps (Vite/Rollup plugins are out of scope for v1).
- **NO** native packaging, store upload tooling, or PWA wrappers (Capacitor/Tauri).

---

## 1.4 Target Consumers & Personas

| Persona | Primary artifact | Typical use case |
|---------|------------------|------------------|
| **React PWA developer** | `@oxelot/react` | Media-heavy gallery, offline form app, local-first collab tool |
| **Vanilla / Vue / Svelte developer** | `@oxelot/core` | Framework-specific integrations written by the consumer |
| **Field-data teams** | `@oxelot/core` + custom SW | Inspection apps that must survive no-connectivity field days |
| **Native-migration teams** | Both | Port a SQLite-on-device app to a PWA without losing storage semantics |
| **PWA infrastructure teams** | `@oxelot/core` | Companies building their own sync layer on top of the durable queue |

### 1.4.1 Consumer expectations contract

1. A consumer never imports from an internal path (e.g. `@oxelot/core/dist/...`); only the facade entry is public.
2. Every async API is Promise-based; nothing throws synchronously from a bridge call.
3. All options have documented defaults; behavior differences between storage backends are normalized by the facade.
4. Opt-out is always available: `storageBackend: 'indexeddb'` forces the fallback path for testing or for Safari < 15.2.

---

## 1.5 Glossary (controlled vocabulary)

Terms used identically across all chapters; do not substitute synonyms.

| Term | Definition |
|------|-----------|
| **Facade** | The single public entry class `Oxelot` exposing `storage`, `db`, `sync`, `hardware`, `pool`, and `on()`. |
| **Bridge** | The typed `postMessage` RPC layer (`OxelotBridge`) between main thread and workers. |
| **Pool** | `OxelotPool`; N worker instances with FIFO dispatch and load tracking. |
| **Envelope** | An `OxelotMutation` record queued for background sync. |
| **Replay** | Re-dispatching a previously queued envelope against the consumer's server. |
| **Dead letter** | An envelope that fails permanently and is quarantined with its error. |
| **OPFS** | Origin Private File System; the per-origin, sandboxed file API backing primary storage. |
| **Sync handle** | `FileSystemSyncAccessHandle`, worker-only, high-throughput file handle. |
| **Long task** | A main-thread task ≥ 50ms per the Performance Long Tasks spec; Oxelot's budget is 16ms. |
| **Fugu** | Project Fugu API family (Web NFC, WebUSB, Web Bluetooth, Wake Lock, etc.). |

---

## 1.6 Document map

- Roadmap & milestones → [Chapter 2](02-planning-roadmap.md)
- Architecture & tech stack → [Chapter 3](03-tech-stack-architecture.md)
- Decisions (ADR-01..03) → [Chapter 4](04-ADR/README.md)
- Modules & API contracts → [Chapter 5](05-core-modules-and-specs.md)
- Threading model → [Chapter 6](06-state-management-threading.md)
- Rules & performance budget → [Chapter 7](07-boundaries-constraints.md)
- Dev setup & testing → [Chapter 8](08-developer-guide.md)
- Build order & boilerplate → [Chapter 9](09-implementation-guide.md)
- Consumer usage → [Chapter 10](10-user-guide.md)
