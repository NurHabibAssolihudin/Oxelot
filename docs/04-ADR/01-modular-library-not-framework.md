# ADR-01 — Build a Modular Library, not a UI Framework

## Status
Accepted

## Context
Oxelot's value proposition is *native-class data, storage, and background bridging for the open web*. Two candidate product shapes were on the table:

1. A **full framework** (owning rendering, reactivity, and component lifecycle — i.e., a competitor to React/Vue/Svelte).
2. A **modular library** that delegates rendering to the consumer's framework of choice.

Constraints at decision time:
- The team is small; a framework's long-term maintenance burden (reactivity engine, scheduler, renderer, virtual DOM, CLI, docs, ecosystem) is far beyond the bridge's scope.
- The web UI ecosystem is mature; developers already have strong opinions and locked-in stacks. A new framework creates adoption resistance.
- The core engineering risk of Oxelot is in storage threading, WASM, and background sync — not in rendering.
- Goals G5 (no DOM), G6 (framework-agnostic core), and G7 (small bundle) are easier to guarantee for a library than for a framework.

## Decision
**Build a modular library, not a UI framework.**

- Ship **`@oxelot/core`**: a framework-agnostic engine exposing a facade (`Oxelot`) + classes, with **zero** imports of any UI framework (G6).
- Ship **`@oxelot/react`**: an optional, thin bindings layer (hooks) that re-exports core. React types/APIs appear **only** in this package.
- The core must never render, style, or read the DOM (G5).
- The public API is data/status in, promises out; consumers own all UI.

## Consequences
**Positive (+):**
- Core can be tested headlessly (no DOM, no framework) — enabling the strict CI gates in Chapters 2 and 7.
- Adopting teams keep their framework; integration cost is one import.
- Bundle stays small; tree-shaking works because the facade is a small entry.
- UI-framework churn (React 19, Svelte 5, …) cannot break core consumers.

**Negative (−):**
- Vanilla/Vue/Svelte consumers get no out-of-the-box reactivity glue; they write a small adapter (documented in Chapter 10 §10.4).
- We must maintain adapter discipline: react bindings are *derived* from core primitives and never the reverse; otherwise the abstraction leaks.

**Neutral (~):**
- The react package adds one more artifact to build, test, and publish per release (build order core → react, Chapter 2 §2.5).

## Alternatives considered
- **Full framework** — rejected: scope explosion, adoption friction, violates G5/G6/G7.
- **Plugin architecture with optional adapters for each framework** — rejected for v1: adapters beyond React add maintenance surface before traction is proven. Revisit at v0.3+ based on demand.
- **Compiler/macro-based approach** — rejected: requires toolchain coupling (babel/esbuild plugins), contradicts "just a library".
