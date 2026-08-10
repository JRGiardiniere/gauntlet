# Gauntlet

Effect-v4-native, Pi-harnessed code-review agent. Spec is decision-complete;
work arrives as tickets (#16–#26). Don't re-litigate settled decisions.

## Read first

- `CONTEXT.md` — the domain terms and their avoid-lists are **binding on naming**
- Spec: issue #15. Rationale: `docs/adr/` (0001–0006, binding)
- `docs/spec/pipeline-shape.md`, `docs/spec/emit-tools.md` — normative specs
- `docs/effect-house-style.md`, `docs/effect-v4-patterns.md` — house style,
  verified against the pinned Effect beta

## Expectations

- `pnpm lint && pnpm typecheck && pnpm test` stays green. The gate includes 13
  custom rules that reject common Effect idioms (Schema.Class, raw throw,
  unbounded retries…) — read the rule's message, don't fight it
- Effect pinned **exactly** (enforced); single `effect` package, unstable
  subpaths fine; no new runtime dependencies without strong cause
- Tests sit at the highest seam: CLI command in → stdout/exit/run-dir out,
  against the scripted HarnessSession adapter and a real temp filesystem.
  TestClock never auto-advances. Fixture lenses only — never real lens names
- `content/` is pure content (`{{PLACEHOLDER}}` slots) — code loads it, never
  edits it; lens hashes are the run-comparability mechanism
- Personal tool: no speculative safeguards. A new protection needs a measured
  or structural justification (standing directive from #8)
