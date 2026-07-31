# 7. Boundaries & Constraints (Strict Anti-Patterns)

**Chapter status:** Final (v0.1.0) · **File:** `docs/07-boundaries-constraints.md`

The constraints in this chapter are **non-negotiable**. Violations are CI failures and review blockers. Each constraint lists its enforcement mechanism so there is no ambiguity about what "compliant" means.

---

## B-1 No UI Rendering Logic

**Rule:** `@oxelot/core` must never read or write `document`, `window`, `HTMLElement`, `CSS`, or `style`. It must never create DOM nodes, set attributes, or schedule layout.

**What core MAY do:** receive and return typed data/status; emit events; spawn workers; use `navigator`/`navigator.storage`/`crypto` (platform services, not UI).

**Enforcement (three independent checks):**
1. **Static — ESLint:** in `packages/core`, restrict globals `document`, `window`, `HTMLElement`, `Element`, `Node`, `CSS` via `no-restricted-globals`; `no-restricted-syntax` forbids `document.`, `window.`, `.style`, `.classList`, `getElementById`, `querySelector`.
2. **Runtime probe — Playwright:** boot `@oxelot/core` in a **DOM-less context** (a worker scope with `window`/`document` undefined) and assert `Oxelot.init()` resolves. A successful boot proves no DOM dependency at runtime.
3. **Published-artifact scan — CI:** grep of `dist/index.js`/`.cjs` for `\bwindow\b` / `\bdocument\b` returns zero matches.

**Rationale:** rendering must remain the consumer framework's job; Oxelot returning data + status keeps it framework-agnostic (ADR-01, G5/G6).

---

## B-2 No Framework Lock-In

**Rule:** `@oxelot/core` must be pure TypeScript with **zero** imports of any UI framework (React, Vue, Svelte, Solid, Angular, Preact, Mithril, etc.) — in `dependencies` and in transpiled output.

**Enforcement:**
1. **dependency-cruiser** rule: any import path containing `react`, `vue`, `svelte`, `solid`, `angular`, `preact` from `packages/core/src/**` fails CI.
2. **Package manifest check:** `packages/core/package.json` has no such dependencies (only zero runtime deps in v1; the WASM glue is loaded dynamically via a small inline loader).
3. `@oxelot/react` is the **only** allowed React surface; it imports core, never the reverse.

**Rationale:** ADR-01; consumers on any framework use the same core, and core is testable headlessly.

---

## B-3 Performance Budget (hard numbers)

| Metric | Budget | Measured where |
|--------|--------|----------------|
| Main-thread long task | **< 16ms** (target 0ms during normal ops) | Playwright long-task observer during 30s scripted workload (G1) |
| Worker request→response round-trip (no payload) | **p95 < 16ms, max < 32ms** | Bridge self-test + e2e (G3) |
| Worker round-trip with 1 MiB transferable buffer | **p95 < 20ms** | e2e (uses `transfer`, not clone) |
| `enqueue()` (persist envelope, no network) | **< 5ms** main-thread contribution | hook instrumentation |
| WASM SQLite lazy init | **≤ 100ms** after first `db` request, mid-tier Android | e2e on device profile (G7) |
| `@oxelot/core` gzip | **≤ 35 KB** excluding `.wasm` | CI size-check (G7) |
| `Oxelot.init()` | **resolves ≤ 250ms** from call to `ready` event | e2e |

**Enforcement:** `test:perf` script runs the workload + asserts; any overage fails CI. Instrumentation code lives in a `__timing__` module used by both self-tests and e2e.

---

## B-4 API Stability

**Rule:** The `Oxelot` facade (§5.5.2) is the **sole** public surface. Consumers must never import from internal paths.

**Enforcement:**
1. `packages/core/package.json` `exports` map exposes only `./` (facade) — internal paths are not in `exports`, so bundlers resolve them to `ERR_PACKAGE_PATH_NOT_EXPORTED`.
2. Any change to a public type/signature requires an ADR (Chapter 4) and a `minor`/`major` semver bump.
3. A type-level contract test (`api-extractor`-style `.api.md` snapshot) is committed and diffed on every PR.

---

## B-5 Error Discipline

**Rule:** Every rejected promise and thrown error is an `OxelotError` with a `code` from the normative table (§5.6). No bare `Error` with an unstructured message crosses the public API.

**Enforcement:** ESLint rule + unit test iterating every code in §5.6; e2e asserts specific codes for the known scenarios (`ERR_OPFS_MAIN_THREAD`, `ERR_FILE_NOT_FOUND`, etc.).

---

## B-6 No Silent Data Loss

**Rule:** Oxelot never drops a persisted envelope without surfacing it.

**Enforcement:**
1. Dead letters are quarantined and counted (`status().deadLetters`, §5.2.3).
2. `storage-change`/`sync-state` events always reflect true state after any mutation.
3. Write failures reject the originating promise with an `OxelotError`; optimistic rollback is emitted as an event (§6.3.2).

---

## B-7 Secrets & Security

**Rule:** Core never sends, logs, or persists credentials/tokens. Envelope payloads may contain user data, but core treats them as opaque.

**Enforcement:**
1. No logging of `payload` contents (only ids/counts/errors).
2. Daemon wire protocol carries no secrets (Chapter 5 §5.4.4).
3. `navigator.storage` and OPFS are origin-scoped; core never requests cross-origin storage access.

---

## B-8 Anti-pattern checklist (review gate)

Before any PR is merged, the reviewer verifies **all** of the following:

- [ ] No `document`/`window`/`.style`/`.classList` in `packages/core/src`.
- [ ] No framework imports in `packages/core`.
- [ ] `@oxelot/react` only re-exports/wraps core primitives.
- [ ] Every public rejection is `OxelotError` with a code from §5.6.
- [ ] Binary transfers use `transfer` (no structured-clone of buffers).
- [ ] No new public type/export without ADR + `exports` map update.
- [ ] No timing regression: `test:perf` green.

---

## Chapter cross-references
- Why these exist (goals): [Chapter 1 §1.3](01-project-overview.md)
- ADR basis: [Chapter 4](04-ADR/README.md)
- How to measure: [Chapter 8 §8.4](08-developer-guide.md)
