# gauntlet

Effect-v4-native, Pi-harnessed, model-agnostic code-review agent. ("Run the
gauntlet on medium.")

**Status: pre-implementation.** Design decisions are being worked as a
[Wayfinder map](https://github.com/JRGiardiniere/gauntlet/issues/1); the spec
lands when the map's tickets close.

## Toolchain

- pnpm + TypeScript 7 (tsgo), Node ≥ 23.6
- `effect` / `@effect/platform-node` / `@effect/vitest` pinned **exactly** to
  `4.0.0-beta.106` (enforced by `scripts/check-effect-pin.mjs`)
- `pnpm lint` — the house-style gate: oxlint baseline + the `gauntlet` custom
  rule pack (`scripts/lint-rules/`), a `Record<string, unknown>` early-warning
  scan, official type-aware Effect diagnostics (`@effect/tsgo`), the exact-pin
  check, and an import-cycle check
- `pnpm test` — vitest (`@effect/vitest`), covering the lint rules and Effect code
- `pnpm typecheck` — tsgo

## Docs

- `docs/effect-house-style.md`, `docs/effect-v4-patterns.md` — house style +
  patterns, imported from cloudflare-hub (see the provenance banners for
  beta.90 → beta.106 deltas)
- `docs/research/` — Wayfinder research findings (Effect batteries, durable
  execution, Pi harness surface)
- `docs/STARTING-POINT.md` — pre-charting exploration; deleted once the spec lands
