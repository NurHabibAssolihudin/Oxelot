# Known Limitations (v0.1.0)

**Chapter status:** Draft · **File:** `docs/known-limitations.md`

Recorded per Chapter 8 §8.4.4 (manual device matrix) and the release procedure
(Chapter 2 §2.5, step 4).

## WASM SQLite

| Limitation | Detail | Tracking |
|------------|--------|----------|
| Image-based persistence (not byte-level VFS) | M1.4 ships `sqlite3_serialize`/`deserialize` whole-image writes to OPFS (ADR-05). Write amplification is O(db size) per mutation and the full OPFS VFS (spec §5.1.4) is the deferred end-state. | ADR-05 |
| `.wasm` asset ~1.1 MB | Lazy-loaded at first `db.*` op; excluded from the G7 JS bundle gate. Fetch + instantiate time is bounded by the G7 e2e on desktop Chromium. | G7 e2e |
| WASM-ready ≤100 ms (Android) | The 100 ms budget targets mid-tier Android and is verified only in the **manual device matrix**; desktop CI asserts a generous 5 s bound. | Chapter 8 §8.4.4 |
| `db.*` pinned to one worker | SQLite is a single in-memory instance; all db ops route to worker 0 (ADR-05). Parallelism for db-heavy apps is limited to one worker. | ADR-05 |

## Storage

| Limitation | Detail | Tracking |
|------------|--------|----------|
| G2 full 500 MB soak is manual | The 500 MB write→reload→read byte-exact soak runs via `npm run test:g2-full` (or the manual matrix). GitHub Actions has CI time limits, so PRs run a 5 MB byte-exact smoke (`opfs` tag). | `packages/e2e/g2-full.spec.ts` |
| WebKit OPFS coverage | The `opfs`-tagged tests run under the WebKit project but WebKit is only exercised where Playwright browsers are installed (manual/local); CI runs Chromium. | `playwright.config.ts` |
| `BroadcastChannel`/`sessionStorage` availability | Cross-tab `storage-change` degrades to a no-op where these are unavailable (privacy modes); single-tab behaviour is unchanged. | ADR-06 |
| Web Locks: `ifAvailable` co-ordination unreliable | Some Chromium builds grant `ifAvailable: true` requests even while another realm holds the lock, so flush arbitration uses **blocking** `oxelot-sync` acquisition (exactly one active flusher) and the `oxelot-storage:<name>` guard uses blocking locks. `ifAvailable`/skip semantics exist as diagnostics only. | M2.3 §5.2.5, slice 0.2 caveat |
| Web Locks availability in realms | The storage guard and SW flush lock degrade to no-ops where `navigator.locks` is unavailable (Node, and engine/worker combinations lacking Web Locks); correctness then falls back to IDB transaction atomicity + consumer idempotency by `id`. | `core/storage/locks.ts`, `sw.ts` |

## Background sync (M2.4)

| Limitation | Detail | Tracking |
|------------|--------|----------|
| `periodicsync` registration rejected in CI | Chrome grants periodic background sync only to installed/PWA-permitted origins with engagement; headless `registration.periodicSync.register()` rejects and is swallowed as a logged no-op (`console.info`). CI asserts the registration guard never breaks boot + live `syncCapabilities()` parity; real periodic firing is manual (Ch. 8 §8.4). | `periodic-sync.spec.ts` 4.1–4.2 |
| No periodic sync on Firefox/Safari | `registration.periodicSync` is absent → feature degrades to a no-op; connectivity-restore sync (`registration.sync`) and the page `online` flush still cover offline delivery. | §5.2.7 |
| Engine min-interval clamping | The configured interval is a *minimum*; engines enforce their own larger cadence. Consumers must not rely on a faster effective rate. | §5.2.7 |

## Hardware bridge (M2.5)

| Limitation | Detail | Tracking |
|------------|--------|----------|
| Native prompts are the manual matrix | `acquire()` maps to the real gesture-gated prompt (WebUSB/Bluetooth `requestDevice`, NFC `scan`, FSA picker), which CI cannot drive to completion. CI covers the error-code truth table and the unsupported path; device/NFC/USB flows are the manual matrix (Ch. 8 §8.4). | `hardware.test.ts`, `hardware.spec.ts` |
| Desktop truth table only | `hardware.spec.ts` records the *desktop* truth table for Chromium/WebKit/Firefox (e.g., `nfc:false`, `vibration:false` on desktop Firefox/WebKit). Android-only APIs (NFC) must be re-verified on-device. | `hardware.spec.ts` EXPECTED |
| OS-dependent `bluetooth` exposure | Chromium exposes `navigator.bluetooth` only when the host has a Bluetooth stack (Windows/macOS/Android); headless Linux runners (CI, no BlueZ service) report `bluetooth:false`. `EXPECTED.chromium` in `hardware.spec.ts` is platform-aware for this field (checked via Linux probe: `usb`/`wakeLock`/`fileSystemAccess`/`vibration` remain `true`). | `hardware.spec.ts` 5.2 |
| Firefox not in the default suite | The firefox project is env-gated (`PW_MATRIX=1`) because the browser isn't installed by default; run it explicitly for the 3-browser matrix. | `playwright.config.ts` |

## Platform / browser matrix (manual, not automated)

| Platform | Coverage | Notes |
|----------|----------|-------|
| Android Chrome | OPFS + SW + Fugu NFC/USB smoke, G7 WASM-ready ≤100 ms | Manual; `docs/known-limitations.md` updated at first run |
| iOS Safari ≥ 15.2 | OPFS persistence + IndexedDB fallback + install prompt | Manual; WebKit project covers automated subset where browsers installed |
| Desktop Chromium | Full suite | Automated in CI |

## Tooling notes

- `@vitejs/plugin-react@4` is pinned because v6 requires vite 8; this repo uses vite 5.
- WebKit browser binaries are not installed in the default local env (missing system deps); install with `npx playwright install webkit --with-deps` where a full matrix is required.
