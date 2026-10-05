# Gauntlet

Effect-v4-native, Pi-harnessed code-review agent. Spec is decision-complete;
work arrives as tickets (#16–#26). Don't re-litigate settled decisions.

## Read first

- `CONTEXT.md` — the domain terms and their avoid-lists are **binding on naming**
- Spec: issue #15. Rationale: `docs/adr/` (0001–0008, binding)
- `docs/spec/pipeline-shape.md`, `docs/spec/emit-tools.md` — normative specs
- The `effect` skill for Effect code, with the House rules below

## Expectations

- `bun run lint && bun run typecheck && bun run test` stays green. A fresh
  checkout runs `bun run mod-types` once first: Claude Code writes the
  mod's plugin declarations into `mod/types/` (gitignored); rerun it after a
  Claude Code update. The gate includes
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

## House rules

Gauntlet's own deviations and constraints. Everything else follows the shared
skills (`effect` for Effect code). The skills come from Convoy, in `~/.claude/skills/` and `~/.agents/skills/`.

### Effect

- `scripts/check-effect-pin.ts` enforces the exact pin. A CLI switch whose
  omission means false is `Flag.boolean(...).pipe(Flag.withDefault(false))`;
  `Flag.optional` is for an absence with its own meaning.
- Service ids are `gauntlet/Name`. `HarnessSessionFactory` has separate live and
  scripted Layers instead of `Default`/`Fake`, because both adapters share Pi's
  Promise and callback contract.
- Node globals and `node:*` imports are fine at runtime and SDK adapter
  boundaries; application logic uses the `FileSystem` and `Path` services.
- The executable boundary is `bin/gauntlet.ts`; `runGauntlet` renders typed
  failures as CLI messages and exit codes. Pi's Promise and callback contracts
  are bridged in its adapters (`src/harness/pi-live.ts`), whose mutable cells
  belong to that contract.
- Expected invocation endings (provider endings, timeouts, missing emits) are
  `AgentOutcome.termination` data, as `CONTEXT.md` defines, not errors.
  `invoke.ts` keeps usage and available output beside an unsuccessful
  termination, and relies on `Effect.raceFirst` for its watchdogs.
- Finder partitions and evaluation scheduling are deliberate, and Pi owns
  provider retries (ADR-0002): don't add concurrency limits or retries there.
  `concurrency: "unbounded"` is allowed in the pipeline; partial work still
  produces an explicit coverage gap or a typed failure.
- Durable Run artifacts and delivery effects are outside finalizer rollback.
  Artifact writes go to a sibling temporary file and rename.
- A tool or domain contract's schema is authoritative for its TypeScript type,
  decoder and JSON Schema projection. Pi events can carry an explicit
  `undefined`, so adapter schemas allow it; persisted JSON uses
  `Schema.optionalKey`.
- `runGit` scrubs the Git environment variables that could redirect its working
  directory. Tests use real temporary filesystems and fixture Git repositories,
  and filesystem-backed settings use fixture files through the injected home
  boundary.
- Linear's GraphQL reads are POSTs and are retried; posting a delivery comment
  is not. Linear's page limits bound its lookups.
- The update cache is disposable, so an unreadable one degrades to no notice.
- Span names in existing code still use `gauntlet.<module>.<method>`; new code
  uses the skill's `Domain.operation`, and the renames are #126.
