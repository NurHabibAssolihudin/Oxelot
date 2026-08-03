# 4. Architecture Decision Records (ADR)

**Chapter status:** Final (v0.1.0) · **File:** `docs/04-ADR/README.md`

An ADR captures a decision with **context**, **decision**, and **consequences** so future agents and humans can re-derive *why* the code is shaped this way without guessing.

---

## ADR List

| ID | Title | Status | Decision date |
|----|-------|--------|---------------|
| [ADR-01](01-modular-library-not-framework.md) | Modular library, not a UI framework | Accepted | Draft |
| [ADR-02](02-opfs-over-indexeddb.md) | OPFS over plain IndexedDB for high-throughput I/O | Accepted | Draft |
| [ADR-03](03-pwa-open-web-distribution.md) | PWA & open-web distribution over native app stores | Accepted | Draft |
| [ADR-04](04-worker-config-delivery.md) | Deliver worker configuration over the existing request/response bridge | Accepted | Draft |

---

## Rules of the ADR register

1. **New public API change ⇒ new ADR** (or amendment). This is enforced by B-4 (Chapter 7).
2. **Status values:** `Proposed` → `Accepted` → `Superseded` (link to superseding ADR). Never deleted.
3. **Template** (mandatory sections):

```markdown
# ADR-NNN — <Title>

## Status
<Proposed | Accepted | Superseded by ADR-XXX>

## Context
<What problem? What constraints? What forces shape the decision?>

## Decision
<The concrete choice, stated in imperative form. Include interfaces or filenames where relevant.>

## Consequences
<Positive (+), negative (−), and neutral (~). Be specific.>

## Alternatives considered
<Briefly list rejected options and why.>
```
