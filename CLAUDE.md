# Gauntlet

Effect-v4-native, Pi-harnessed code-review agent. Spec is decision-complete;
work arrives as tickets (#16–#26). Don't re-litigate settled decisions.

## Read first

- `CONTEXT.md` — the domain terms and their avoid-lists are **binding on naming**
- Spec: issue #15. Rationale: `docs/adr/` (0001–0008, binding)
- `docs/spec/pipeline-shape.md`, `docs/spec/emit-tools.md` — normative specs
- `docs/effect-house-style.md`, `docs/effect-v4-patterns.md` — house style,
  with Gauntlet examples and guidance for the Effect version in `package.json`

## Expectations

- `bun run lint && bun run typecheck && bun run test` stays green. The gate includes
  custom rules that reject common Effect idioms (Schema.Class, raw throw,
  unbounded retries…) — read the rule's message, don't fight it
- Effect pinned **exactly** (enforced); single `effect` package, unstable
  subpaths fine; no new runtime dependencies without strong cause
- Tests sit at the seam callers use: a Stage module's interface is a
  sanctioned test seam; the CLI suite covers CLI-shaped contracts (exit codes,
  stdout, run-dir layout, resume) plus a few end-to-end journeys — not every
  Stage behavior. Scripted HarnessSession adapter and a real temp filesystem.
  TestClock never auto-advances. Tests provide fixture lens content rather than
  loading the shipped catalog. A production Lens identity appears only when a
  contract is intrinsically attached to that identity (`spec-conformance` skip
  and opt-in selection); all ordinary lens assertions use fixture names
- Lenses are pure content per ADR-0004 (markdown, content-frozen per run) —
  code loads them, never edits them. Stage prompt templates may live with and
  be owned by their Stage module; prompt text is still plain markdown with
  `{{PLACEHOLDER}}` slots, never rewritten at runtime
- Personal tool: no speculative safeguards. A new protection needs a measured
  or structural justification (standing directive from #8)
