# 8. Developer Guide (Environment & Setup)

**Chapter status:** Final (v0.1.0) · **File:** `docs/08-developer-guide.md`

---

## 8.1 Prerequisites

| Tool | Minimum | Purpose | Install check |
|------|---------|---------|---------------|
| Node.js | **20 LTS** (CI also runs 22) | Build, tooling, tests | `node --version` |
| npm | **10+** (bundled with Node) | Monorepo workspaces (`pnpm` is a drop-in alternative) | `npm --version` |
| Rust toolchain | **1.75+** with target `wasm32-unknown-unknown` | WASM SQLite VFS crate | `rustc --version`; `rustup target list --installed` |
| wasm-pack | **0.12+** | Rust → wasm packaging | `wasm-pack --version` |
| Browsers | Chromium (primary), Firefox, WebKit | Playwright e2e | `npx playwright install --with-deps chromium firefox webkit` |

### 8.1.1 One-time environment setup

```bash
# Rust target for WASM
rustup target add wasm32-unknown-unknown

# Install browser binaries for Playwright
npx playwright install --with-deps
```

### 8.1.2 macOS/Windows notes
- macOS: standard Homebrew toolchain works; SIP does not affect this project.
- Windows: prefer WSL2 for the Rust/wasm build; Playwright runs fine under WSL2 with X-less headless mode.

---

## 8.2 Repository Layout (normative)

```
oxelot/
├── package.json               # root: npm workspaces + scripts (below)
├── tsconfig.base.json         # strict baseline shared by all packages
├── eslint.config.mjs          # flat config; B-1/B-2 rules
├── prettier.config.mjs
├── vitest.config.ts           # unit tests (Node, no DOM)
├── playwright.config.ts       # e2e (Chromium/WebKit/Firefox)
├── dependency-cruiser.config.ts
├── .github/workflows/ci.yml   # lint → typecheck → unit → e2e → perf → size
├── packages/
│   ├── core/
│   │   ├── package.json       # @oxelot/core
│   │   ├── tsup.config.ts     # ESM+CJS+d.ts output
│   │   ├── src/
│   │   │   ├── index.ts       # public entry (exports facade + types)
│   │   │   ├── wasm.ts        # lazy WASM loader + cache
│   │   │   ├── errors.ts      # OxelotError + code table (§5.6)
│   │   │   ├── __timing__/    # instrumentation helpers (B-3)
│   │   │   └── core/
│   │   │       ├── index.ts   # Oxelot facade
│   │   │       ├── pool/      # bridge.ts, pool.ts, worker-handler.ts
│   │   │       ├── storage/   # opfs.ts, idb.ts, index.ts, types.ts
│   │   │       ├── sync/      # envelope.ts, queue.ts, scheduler.ts, web-lock.ts
│   │   │       ├── db.ts      # PooledDatabase facade
│   │   │       ├── hardware/  # index.ts (capability detection)
│   │   │       └── types.ts   # OxelotEvent, DatabaseFacade
│   │   ├── test/              # unit tests (vitest)
│   │   └── worker-entry.ts    # bundle entry for pool workers
│   ├── react/
│   │   ├── package.json       # @oxelot/react (depends on @oxelot/core)
│   │   ├── src/hooks.ts       # the four hooks (§5.7)
│   │   └── index.ts           # re-export entry
│   └── e2e/                   # Playwright specs (smoke, G3 timing, B-1 probe)
├── playground/                # Vite app used by Playwright webServer + manual demos
├── scripts/size-check.mjs     # G7 bundle-size gate
├── wasm/
│   ├── Cargo.toml             # workspace crate: sqlite-vfs
│   └── sqlite-vfs/src/lib.rs  # wasm-bindgen exports: init/run/query
└── docs/                      # this suite (README is the index)
```

### 8.2.1 Root scripts (normative contract)

| Script | Runs | Gate |
|--------|------|------|
| `npm install` | bootstraps workspace | — |
| `npm run lint` | eslint all packages | CI |
| `npm run typecheck` | `tsc --noEmit` per package | CI |
| `npm test` | vitest unit (Node) | CI |
| `npm run test:e2e` | playwright (Chromium) | CI |
| `npm run test:perf` | long-task + round-trip assertions | CI |
| `npm run build:wasm` | wasm-pack build in `wasm/` → `packages/core/dist/wasm` | manual/pre-publish |
| `npm run build` | tsup build both packages | pre-publish |
| `node scripts/size-check.mjs` | gzip size assertion (G7) | CI |

---

## 8.3 Tooling Configuration Summaries

### 8.3.1 tsup (`packages/core/tsup.config.ts`)
- Entries: `src/index.ts` (main), `worker-entry.ts` (worker bundle → `dist/worker.js`), `sw.ts`.
- `format: ['esm','cjs']`, `dts: true`, `sourcemap: true`, `treeshake: true`, `target: 'es2022'`.
- `define: { 'process.env.NODE_ENV': '"production"' }` for the lib build.

### 8.3.2 ESLint (`eslint.config.mjs`)
- ESLint 9 flat config + `typescript-eslint` **strictTypeChecked** presets. (`eslint-plugin-deprecation` v3 is incompatible with ESLint 9 and is not used.)
- B-1 rules: `no-restricted-globals` (`document`, `window`, `HTMLElement`, `Element`, `Node`, `CSS`) + `no-restricted-syntax` selectors for `document.*`, `window.*`, `.style`, `.classList`, `getElementById`, `querySelector` — scoped to `packages/core/src/**`.
- B-2 rule: `import/no-restricted-paths` forbidding framework packages from `packages/core` (planned; see note in §8.3.3).
- Note: several strictTypeChecked rules that fight the normative API contract are tuned off (see `eslint.config.mjs` header comments): `require-await`, `no-unnecessary-type-parameters`, `no-redundant-type-constituents`, `no-confusing-void-expression`, `no-non-null-assertion`; `restrict-template-expressions` allows numbers.

### 8.3.3 dependency-cruiser
- Rule: `no-unreachable-from-root` plus a custom `forbidden` for framework packages reachable from `packages/core/src` (B-2 enforcement). Not yet wired in CI — the `@oxelot/core` `package.json` has zero runtime dependencies, satisfying G6 directly.

### 8.3.4 Vitest (`vitest.config.ts`)
- Environment: `node`; include `packages/*/test/**/*.test.ts`.
- Bridge protocol is unit-tested against a mock `Worker` (no real `Worker` in unit tests); real worker round-trip timing is exercised in Playwright (G3).
- Coverage thresholds: statements ≥ 80%, branches ≥ 75% for `core`.

### 8.3.5 Playwright (`playwright.config.ts`)
- Projects: `chromium` (default), plus `webkit` for OPFS-specific tests (labelled `opfs`).
- `webServer`: `vite --port 5199` serving `playground/` on `http://localhost:5199` (secure context via localhost).
- SW tests: use `serviceWorkers: 'allow'` context option; Background Sync emulated with Chrome DevTools Protocol `Emulation.setEmulatedNetworkConditions` + manual `ServiceWorkerGlobalScope.registration.showNotification` trick or `registration.sync.register('oxelot-sync')` where available.

---

## 8.4 Testing Strategy

### 8.4.1 Layer matrix

| Layer | Runner | Coverage |
|-------|--------|----------|
| Unit (logic) | Vitest (Node) | Envelope serialization, backoff schedule math, error codes, storage selection factory, web-lock wrapper (mocked `navigator.locks`) |
| Worker context | Vitest (mock `Worker`) | Bridge protocol over a mocked `postMessage`/`message` channel |
| Integration | Playwright (Chromium) | Worker spawn + round-trip timing (G3); OPFS persistence across reload (G2); SW registration + sync flush; Web Locks two-context contention; `Oxelot.init` ready event |
| Perf gate | Playwright (Chromium) | Long-task observer during 30s workload (G1); bridge round-trip p95 (G3) |
| Browser matrix | Playwright WebKit | OPFS availability; fallback to IndexedDB path |

### 8.4.2 Required test fixtures

| Fixture | Purpose |
|---------|---------|
| `fixtures/heavy-workload.ts` | 30s scripted read/write/query loop driving `storage`, `db`, `sync` |
| `fixtures/long-task-collector.ts` | `PerformanceObserver('longtask')` recording durations |
| `fixtures/opfs-500mb.ts` | G2 dataset generator + byte-exact verification |
| `fixtures/envelope-soak.ts` | 100k-envelope offline queue + simulated reconnect (G4) |

### 8.4.3 CI pipeline (`.github/workflows/ci.yml`)

```
job: quality     (node 20, npm cache)   lint → typecheck → unit (vitest)
job: build-and-size (needs quality)     build (tsup) → size gate (G7)
job: e2e          (needs build-and-size, playwright browsers)  chromium e2e
```

Notes: `build:wasm` requires the Rust toolchain and is run manually/pre-publish (not in CI); perf gate (`test:perf`) is wired once the @perf specs are added to `packages/e2e`.

### 8.4.4 Manual device matrix (documented, not automated)
- Android Chrome: OPFS + SW + Fugu NFC/USB smoke.
- iOS Safari ≥ 15.2: OPFS persistence + IndexedDB fallback + install prompt.
- Desktop Chromium: full suite.
Results recorded in `docs/known-limitations.md` (created at first manual run).

---

## 8.5 Getting Started (developer)

```bash
git clone <repo> oxelot && cd oxelot
npm install
npm run build:wasm
npm test          # unit
npm run test:e2e  # integration
npm run dev       # playground at http://localhost:5199
```

First-timer task: run `npm run test:e2e`, read the failing OPFS fixture, then read [Chapter 9 §9.3](09-implementation-guide.md) (bridge) before touching code.
