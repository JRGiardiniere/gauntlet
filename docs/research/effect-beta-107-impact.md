# Effect beta.107 impact on Gauntlet

- **Date:** 2026-08-11
- **Compared:** `effect@4.0.0-beta.106` (`fb75264`) to
  `effect@4.0.0-beta.107` (`3c495ae`)
- **Scope:** Gauntlet's current Effect CLI and Node/test integrations, plus the
  proposed stage-neutral journaled-invocation primitive.
- **Primary sources:** the official Effect
  [tag-to-tag comparison](https://github.com/Effect-TS/effect/compare/fb75264aa78a17a12c5e69adb139fccc421acae0...3c495ae7c96d43bfc3b8020250562a194c2c895e),
  [beta.107 source](https://github.com/Effect-TS/effect/tree/3c495ae7c96d43bfc3b8020250562a194c2c895e),
  package changelogs, changesets, and published npm metadata.

## Bottom line

**No beta.107 change alters the current implementation plan or the
stage-neutral journal handoff.** The CLI change does not add flags with optional
values, so Gauntlet should keep its localized bare-`--resume` normalization.
The journal proposal should still use the existing Effect schema factory,
artifact read/write functions, and generic `invoke<Output>` seam as designed.

An upgrade is low-risk but not a prerequisite. If adopted, make it a tiny
dependency-maintenance change before the journal refactor: update the exact
`effect`, `@effect/platform-node`, and `@effect/vitest` pins together, regenerate
the lockfile, and update `scripts/check-effect-pin.mjs`. Do not mix CLI or
journal redesign into that bump.

## What changed and what it means here

### CLI `UserError` rendering

**Fact.** `Command.run` and `Command.runWith` now render an explicitly returned
`CliError.UserError` through the installed `CliOutput.Formatter`, then rethrow
it. `UserError` gained an optional safe `userMessage`, and command configuration
gained `renderErrors: false` for hosts that render errors themselves
([official changeset](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/.changeset/pre/render-cli-user-errors.md),
[`Command.runWith` source](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/cli/Command.ts#L1783-L1789),
[`UserError` source](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/cli/CliError.ts#L478-L556)).

**Inference for Gauntlet.** This is behaviorally inert. Gauntlet's handler fails
with its own typed domain errors and renders them in `runGauntlet`; it does not
construct `CliError.UserError`. Leave `renderErrors` at its default because the
CLI still owns parse-error rendering while Gauntlet's `ShowHelp` catch only
chooses exit code 0 or 1. Converting all domain failures to `UserError` would
require another mapping layer and change the output format, rather than delete
meaningful code.

### Bare `--resume` remains unsupported natively

**Fact.** Beta.107's `Flag.ts` is unchanged from beta.106. `Flag.string` still
defines a valued flag, `Flag.optional` makes the whole flag optional by wrapping
its result in `Option`, and `withMetavar` only changes help metadata
([`Flag.string`](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/cli/Flag.ts#L54-L57),
[`Flag.withMetavar`](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/cli/Flag.ts#L514-L538),
[`Flag.optional`](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/src/unstable/cli/Flag.ts#L594-L610)).

**Inference for Gauntlet.** Keep the current `@latest` sentinel rewrite in
`src/cli/main.ts`. Beta.107 provides no cleaner native representation of a flag
that accepts either no value or one run ID.

### Schema changes do not touch the journal proposal

**Fact.** Beta.107 requires callers importing a JSON Schema document to choose
how regular-expression constraints are handled. The change is in
`SchemaRepresentation.fromJsonSchemaDocument` and its internal decoder
([release entry](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/CHANGELOG.md#L19-L21),
[#7149](https://github.com/Effect-TS/effect/pull/7149)). Gauntlet instead owns
Effect `Schema` values and exports model tool schemas with
`Schema.toJsonSchemaDocument`; it does not import external JSON Schema
documents.

**Inference for Gauntlet.** `OutputContract.schema` can remain the single schema
source for model tools, `AgentOutcome` persistence, and resume decoding. The
proposed parameterized invocation artifact and `executeJournaledInvocation`
need no beta.107-specific option or adapter.

### Node and test packages remain lockstep-compatible

**Fact.** The published beta.107 Node package peers on beta.107 Effect and the
published beta.107 Vitest package peers on beta.107 Effect plus Vitest 4.1.x
([`@effect/platform-node` npm metadata](https://registry.npmjs.org/@effect%2fplatform-node/4.0.0-beta.107),
[`@effect/vitest` npm metadata](https://registry.npmjs.org/@effect%2fvitest/4.0.0-beta.107)).
The Node platform's functional change is to hide ordinary spawned child-process
console windows by default on Windows; detached children retain their visible
console behavior
([platform-node-shared changelog](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/platform-node-shared/CHANGELOG.md#L3-L11),
[#7154](https://github.com/Effect-TS/effect/pull/7154)). `@effect/vitest` has no
package-specific functional change in this release
([changelog](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/vitest/CHANGELOG.md#L3-L11)).

**Inference for Gauntlet.** The Windows behavior is a benign improvement for
the existing Effect `ChildProcess`-backed Git adapter and is irrelevant on the
current macOS workstation. It does not change process ownership, journaling, or
the planned invocation seam.

### Other beta.107 fixes are outside Gauntlet's used surface

**Fact.** The official effect changelog also lists multipart stream termination
and linear collection, canonical `Duration` hashing, and Windows SQL migration
URL handling
([beta.107 changelog](https://github.com/Effect-TS/effect/blob/3c495ae7c96d43bfc3b8020250562a194c2c895e/packages/effect/CHANGELOG.md#L3-L23)).
Gauntlet uses neither multipart nor Effect SQL, and it does not use `Duration`
as a `HashMap`/`HashSet` key.

**Inference for Gauntlet.** None changes behavior or architecture here.

## Compatibility check

An isolated beta.107 substitution was validated against the merged `main`:

- `pnpm typecheck`: passed;
- `pnpm test`: 22 files and 154 tests passed;
- house-style lint: passed after changing the intentional expected-pin check
  from beta.106 to beta.107;
- live Pi gate: passed.

This is execution evidence, not an upstream compatibility promise. The three
Effect packages should remain exact and on the same beta because Gauntlet uses
unstable subpaths and the published Node/Vitest packages declare beta.107 Effect
peers.

## Recommendation

1. **Do not change the feature order or the stage-neutral journal handoff.**
2. **Do not refactor Gauntlet error rendering around beta.107 `UserError`.** It
   does not remove the domain-specific mapping Gauntlet still needs.
3. **Keep the bare-`--resume` normalization.** Beta.107 has no optional-valued
   flag primitive.
4. **Optional dependency bump:** if staying on the current Effect beta is worth
   a small maintenance PR, upgrade the three pins together before beginning the
   journal PR. The bump is independently reviewable and should contain no
   feature changes.
