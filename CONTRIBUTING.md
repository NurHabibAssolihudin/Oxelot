# Contributing to Oxelot

Thanks for your interest in contributing. Oxelot is an open-source project
licensed under the [MIT License](LICENSE). By contributing, you agree that
your contributions are distributed under the same license.

## Before you start

Read these documents in order:

| Document | Purpose |
|----------|---------|
| [`docs/01-project-overview.md`](docs/01-project-overview.md) | What Oxelot is and the problem it solves |
| [`docs/07-boundaries-constraints.md`](docs/07-boundaries-constraints.md) | Hard gates (no DOM, no framework lock-in) — these are enforced by CI |
| [`docs/08-developer-guide.md`](docs/08-developer-guide.md) | Environment setup and testing strategy |

## Setup

```bash
npm ci
npm run dev
```

## Pull request checklist

- [ ] `npm run lint` passes
- [ ] `npm run typecheck` passes
- [ ] `npm test` passes (unit tests)
- [ ] E2E (if your change touches the browser surface): `npx playwright test --project=chromium`
- [ ] New public APIs require an ADR — see [`docs/04-ADR/README.md`](docs/04-ADR/README.md)
- [ ] Bundle gate stays within budget: `npm run build && node scripts/size-check.mjs`
- [ ] No `window`/`document` references in `@oxelot/core`

## Hard gates (non-negotiable)

See [Chapter 7](docs/07-boundaries-constraints.md) for the precise definitions:

1. Main-thread long tasks < 16 ms.
2. Worker message round-trip < 16 ms (p95).
3. Zero DOM manipulation in `@oxelot/core`.
4. Zero framework imports in `@oxelot/core`.
5. GB-scale OPFS storage without quota prompts or eviction.

## Reporting issues

Open an issue with a minimal reproduction where possible. If it involves a
hard-gate regression, note which gate failed.
