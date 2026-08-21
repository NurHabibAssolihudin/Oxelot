# 8. Developer Guide (Environment & Setup)

**Chapter status:** Final (v0.1.0) · **File:** `docs/08-developer-guide.md`

---

## 8.1 Prerequisites

| Tool | Minimum | Purpose | Install check |
|------|---------|---------|---------------|
| Node.js | **22 LTS** | Build, tooling, tests | `node --version` |
| npm | **10+** (bundled with Node) | Monorepo workspaces (`pnpm` is a drop-in alternative) | `npm --version` |
| Rust toolchain | **1.97+** with target `wasm32-wasip1` | WASM SQLite VFS crate | `rustc --version`; `rustup target list --installed` |
| zig | **0.16+** | C compiler for the `wasm32-wasip1` target (`wasm32-wasi` was removed in zig 0.16; `scripts/zigcc` maps it) | `zig version` |
| Browsers | Chromium (primary); WebKit only for manual OPFS runs | Playwright e2e | `npx playwright install --with-deps chromium` |

### 8.1.1 One-time environment setup

```bash
# Rust target for WASM (release build target)
rustup target add wasm32-wasip1

# Install browser binary for Playwright (chromium runs the PR suite)
npx playwright install --with-deps chromium

# zig (C compiler for the WASM build). Provide via $ZIG or the zig on PATH;
# scripts/zigcc resolves it. See CI for a pinned release download.
zig version
```

### 8.1.1a Containerized development (recommended on Windows)

All heavy toolchains — Node 22, Rust + `wasm32-wasip1`, zig 0.16, Playwright
Chromium system deps — ship inside the `oxelot-dev` image (`docker/Dockerfile`,
pins identical to CI). The host needs nothing but Docker Desktop; the repo is
bind-mounted into `/app`, and named volumes keep `node_modules`, cargo
artifacts, and browser binaries off the Windows filesystem:

```powershell
.\scripts\d.ps1 quality   # build + lint + depcruise + typecheck + unit tests + G7 size gate
.\scripts\d.ps1 wasm      # build:wasm -> packages/core/dist/wasm/ (visible on the host)
.\scripts\d.ps1 e2e       # full default Chromium suite, incl. SQLite smoke
.\scripts\d.ps1 shell     # interactive bash with every toolchain
```

VS Code users: open the folder and "Reopen in Container" (`.devcontainer/`).
Notes: the first `compose run` downloads ~3 GB of image layers once; browsers
download once per playwright version into the volume; `.\scripts\d.ps1 clean`
removes all container state without touching the host repo.

### 8.1.2 macOS/Windows notes
- macOS: standard Homebrew toolchain works; SIP does not affect this project.
- Windows: prefer WSL2 for the Rust/wasm build; Playwright runs fine under WSL2 with X-less headless mode. The containerized workflow above replaces the manual WSL2 setup entirely.

---

## 8.2 Repository Layout (normative)

```
oxelot/
├── package.json               # root: npm workspaces + scripts (below)
├── tsconfig.base.json         # strict baseline shared by all packages
├── eslint.config.mjs          # flat config; B-1/B-2 rules
├── prettier.config.mjs
├── vitest.config.ts           # unit tests (Node, no DOM)
├── playwright.config.ts       # e2e (Chromium project; WebKit project manual-only)
├── .dependency-cruiser.cjs    # G6 gate config
├── .github/workflows/ci.yml   # quality → build-and-size → e2e
├── .github/workflows/perf.yml # G1 nightly + manual dispatch
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
│   └── e2e/                   # Playwright specs (smoke, G1 perf, G2 OPFS, G7 wasm timing)
├── playground/                # Vite app used by Playwright webServer + manual demos
├── scripts/size-check.mjs     # G7 bundle-size gate
├── scripts/zigcc              # zig wrapper for the wasm32-wasip1 target (reads $ZIG or PATH)
├── wasm/
│   ├── Cargo.toml             # workspace crate: sqlite-vfs (rusqlite 0.40 / libsqlite3-sys 0.38)
│   └── sqlite-vfs/src/lib.rs  # extern "C" exports: alloc/dealloc/init/run/query/export_db/result_ptr/result_len
└── docs/                      # this suite (README is the index)
```

### 8.2.1 Root scripts (normative contract)

| Script | Runs | Gate |
|--------|------|------|
| `npm install` | bootstraps workspace | — |
| `npm run lint` | eslint all packages | CI |
| `npm run depcruise` | dependency-cruiser on `packages` (G6) | CI |
| `npm run typecheck` | `tsc --noEmit` per package | CI |
| `npm test` | vitest unit (Node) | CI |
| `npm run test:e2e` | playwright `--project=chromium --grep-invert "@g2-full\|@perf"` | CI |
| `npm run test:perf` | playwright `--grep @perf` (G1, 30s workload) | nightly + manual (perf.yml) |
| `npm run test:g2-full` | playwright `--grep @g2-full` (500MB OPFS soak) | manual |
| `npm run build:wasm` | `cargo build --target wasm32-wasip1 --release` → `packages/core/dist/wasm/` | CI (e2e/perf) + manual |
| `npm run build` | tsup build both packages | CI |
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
- Config: `.dependency-cruiser.cjs`. Rule: `no-unreachable-from-root` plus a custom `forbidden` entry for framework packages reachable from `packages/core/src` (B-2 enforcement).
- Wired in CI via `npm run depcruise` (quality job). `@oxelot/core` also has zero runtime dependencies, satisfying G6 directly.

### 8.3.4 Vitest (`vitest.config.ts`)
- Environment: `node`; include `packages/*/test/**/*.test.ts`.
- Bridge protocol is unit-tested against a mock `Worker` (no real `Worker` in unit tests); real worker round-trip timing is exercised in Playwright (G3).
- Coverage thresholds: statements ≥ 80%, branches ≥ 75% for `core`.

### 8.3.5 Playwright (`playwright.config.ts`)
- Projects: `chromium` (default, runs the PR suite), plus `webkit` (`testMatch: /opfs/`) for OPFS-specific tests — manual only; CI installs just Chromium and runs `--project=chromium`.
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
| `fixtures/heavy-workload.ts` | 30s scripted read/write/query loop driving `storage`, `db`, bridge (used by @perf) |
| `fixtures/long-task-collector.ts` | `PerformanceObserver('longtask')` recording durations |
| `fixtures/opfs-dataset.ts` | G2 dataset generator + byte-exact verification (shared by 5MB smoke + 500MB @g2-full) |
| `fixtures/oxelot-like.ts` | small browser entry used by specs to drive the real `@oxelot/core` |

### 8.4.3 CI pipeline (`.github/workflows/ci.yml`)

```
job: quality     (node 22)     build → lint → depcruise (G6) → typecheck → unit (vitest)
job: build-and-size (needs quality)  build (tsup) → size gate (G7)
job: e2e          (needs build-and-size)  install chromium + rust(wasm32-wasip1) + zig 0.16
                                 → build → build:wasm → chromium --grep-invert "@g2-full|@perf"
```

Notes: `build:wasm` runs inside the CI `e2e` job (`cargo build --target wasm32-wasip1 --release`); the G1 perf gate runs in a separate `perf.yml` workflow (nightly + `workflow_dispatch`, 30s workload) and the G2 500MB soak (`@g2-full`) is manual.

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
