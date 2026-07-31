# ADR-03 — PWA & Open-Web Distribution over Native App Stores

## Status
Accepted

## Context
Requirement context (Chapter 1 §1.2.2): distributing a "real" native app requires gatekeeping:

- **Google Play closed testing:** ≥ 12 testers, each holding the tester link for **14 continuous days**, before production release.
- **Play Integrity / Play Protect:** sideloaded APKs trigger verification, "unknown app" warnings, and possible remote removal of non-Play installs.
- **Apple review:** 30–60 day queues, entitlement arbitration, 30% commission.
- **Enterprise MDM / region locks:** can block sideloading entirely.

Meanwhile the modern web platform (P1–P6 in Chapter 1) is now *nearly* sufficient for native-class apps when engineered correctly. The team's mission is to make the open web a sufficient distribution channel — not to make the stores' gates less painful.

## Decision
**Oxelot's distribution model is the open web — URL + HTTPS + installable PWA. No store packaging in v1.**

- Distribution = manifest (`display: standalone`) + HTTPS serving + `beforeinstallprompt` (A2HS). Zero store review, zero tester pools, zero sideload verification.
- All Phase 1–2 features (OPFS storage, background sync, Fugu hardware) are available to any Secure Context; consumers serve over HTTPS and register a service worker.
- Hardware Fugu cannot cover (NFC polling without gesture, system-level sockets) is deferred to the **optional** Phase 3 local daemon (`ws://127.0.0.1`, Chapter 5 §5.4), which remains opt-in and out of the core package.
- Payments/discovery/push entitlements that only stores provide are **explicitly out of scope**; consumers own those trade-offs and document them.

## Consequences
**Positive (+):**
- Instant global rollout; no review latency; install is one tap; no tester or sideload gates (G-goal: bypass the 14-day rule by construction).
- Store commission (≈30%) avoided for revenue channels not routed through web payments.
- No Play Integrity/Play Protect friction for users.
- Ship fixes and new phases without a re-review cycle.

**Negative (−):**
- No store-based discovery, store payment rails, or store push entitlements; consumer must own these.
- A handful of hardware APIs remain gesture-bound (Web NFC/WebUSB require user activation); mitigated only by the daemon.
- Some enterprises still block PWAs at the policy level; outside our control.

**Neutral (~):**
- The "app-like" experience now depends on the PWA manifest + SW quality, which Oxelot's consumer checklist (Chapter 10 §10.5) standardizes.

## Alternatives considered
- **Capacitor/Tauri wrapper per store** — rejected for v1: reintroduces the gates and sidesteps the mission; may be documented as a consumer-side option later.
- **Dual-track (web + store)** — rejected: doubles distribution complexity before traction; revisit only if market feedback demands it.
- **Chrome Web Store PWA package** — noted: a possible Phase-3+ addition for discoverability, not a blocker for the core decision.
