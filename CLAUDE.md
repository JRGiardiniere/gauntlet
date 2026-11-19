# Gauntlet

Effect-v4-native code-review agent on an embedded OpenCode Host. Work arrives
as tickets against a decision-complete spec. Don't re-litigate settled
decisions.

## Read first

- `GLOSSARY.md` — the domain terms and their avoid-lists are **binding on naming**
- Spec: issue #195 (v2) and its amendments comment, which win where they
  conflict. Rationale: `docs/adr/` (binding)
- `docs/spec/pipeline-shape.md`, `docs/spec/emit-tools.md` — normative specs
- The `effect` skill for Effect code, with the House rules below

## Expectations

- `bun run lint && bun run typecheck && bun run test` stays green; CI runs
  the same gate on every PR. The gate includes custom rules that reject common Effect idioms (unbounded retries,
  `Effect.promise`, module-level mutable state…) — read the rule's message, don't fight it
- Effect pinned **exactly** (enforced); single `effect` package, unstable
  subpaths fine; no new runtime dependencies without strong cause
- Tests sit at the seam callers use: a Stage module's interface is a
  sanctioned test seam; the CLI suite covers CLI-shaped contracts (exit codes,
  stdout, run-dir layout) plus a few end-to-end journeys — not every
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
- Service ids are `gauntlet/Name`. `HarnessSessionFactory` has separate live
  (`hostHarnessLayer`) and scripted Layers instead of `Default`/`Fake`: its seam
  is one AgentInvocation turn, and the live one is the Host's session driver.
- Node globals and `node:*` imports are fine at runtime and SDK adapter
  boundaries; application logic uses the `FileSystem` and `Path` services.
- The executable boundary is `bin/gauntlet.ts`; `runGauntlet` renders typed
  failures as CLI messages and exit codes. The Gauntlet plugin's per-Host
  registry (`src/host/opencode-agents.ts`) is plain mutable Maps, because
  OpenCode's plugin hooks read it synchronously.
- Expected invocation endings (provider endings, timeouts, missing emits) are
  `AgentOutcome.termination` data, as `GLOSSARY.md` defines, not errors.
  `invoke.ts` keeps usage and available output beside an unsuccessful
  termination; its one watchdog is the overall deadline.
- Finder partitions and evaluation scheduling are deliberate, and the Host owns
  provider retries (ADR-0002): don't add concurrency limits or retries there.
  `concurrency: "unbounded"` is allowed in the pipeline; partial work still
  produces an explicit coverage gap or a typed failure.
- Durable Run artifacts and delivery effects are outside finalizer rollback.
  Artifact writes go to a sibling temporary file and rename.
- A tool or domain contract's schema is authoritative for its TypeScript type,
  decoder and JSON Schema projection. Persisted JSON uses
  `Schema.optionalKey`.
- `runGit` scrubs the Git environment variables that could redirect its working
  directory. Tests use real temporary filesystems and fixture Git repositories,
  and filesystem-backed settings use fixture files through the injected home
  boundary.
- Posting a delivery comment is not retried.
- The update cache is disposable, so an unreadable one degrades to no notice.
- The OpenCode Host loads only through `src/host/live-host.ts`'s dynamic
  import of `src/host/opencode-host.ts`, which with the Gauntlet plugin it
  imports (`src/host/opencode-agents.ts`) is the only code that imports
  `@opencode/*` at runtime, so commands that never use the Host never load
  OpenCode. Its store and every OpenCode global path live under
  `~/.gauntlet/opencode`; session resume is replaced with a no-op because a
  claim has no owner on a shared store.
- Span names in existing code still use `gauntlet.<module>.<method>`; new code
  uses the skill's `Domain.operation`, and the renames are #126.

### Build and release

- Every compiled binary goes through `scripts/compile.ts`: its Bun plugins
  stub `@opencode/pty` and `@ff-labs/fff-bun` (the Host runs with
  `fs.fff: false`) and fix the NodeWS `ws` re-export. A Host that boots under
  `bun` can still fail compiled, so `bun run test:compile-smoke` (PR CI, and
  each release runner) opens it inside a compiled binary.
- Bun is pinned in `package.json`'s `packageManager` and in both workflows;
  change all three together.
- A release is a `v<major>.<minor>.<patch>` tag on `main`, pushed only with
  John's OK. `docs/release-notes/<tag>.md`, when present, goes above the
  generated notes.
- Live gates run by hand, never in CI: `docs/live-gates.md`.
