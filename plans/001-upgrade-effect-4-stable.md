# Plan 001: Upgrade Gauntlet to stable Effect 4

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the
> next step. If anything in the "STOP conditions" section occurs, stop and
> report — do not improvise. When done, update the status row for this plan
> in `plans/README.md` — unless a reviewer dispatched you and told you they
> maintain the index.
>
> **Drift check (run first)**:
> ```sh
> git diff --stat 2e3f49f..HEAD -- package.json bun.lock tsconfig.json .oxlintrc.json scripts/bundle.ts scripts/check-effect-pin.ts scripts/check-import-cycles.ts scripts/lint-house-style.ts scripts/live-gate-compiled.ts src/cli/config.ts src/cli/login.ts src/cli/main.ts src/cli/update-check.test.ts src/cli/update-check.ts src/cli/upgrade.ts src/config/settings.ts src/config/standards-manifest.ts src/github/github.ts src/linear/linear.test.ts src/linear/linear.ts src/run/finder-execution.ts src/stages/judgment/resolution.ts src/target/git.ts src/target/working-tree.test.ts src/target/working-tree.ts src/test-support/git.fixture.ts src/workspace/source-context.ts
> ```
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: migration
- **Planned at**: commit `2e3f49f`, 2026-10-02

## Why this matters

Gauntlet pins `effect`, `@effect/platform-node`, and `@effect/vitest` to
`4.0.0-rc.112`. Stable Effect 4.0.0 is now released, and keeping the RC means
missing the supported stable line while retaining APIs that were removed or
renamed before final. This migration preserves Gauntlet's behavior while moving
all synchronized Effect packages to 4.0.0, accepting the required Vitest 5
upgrade, and moving the Effect language-service/lint integration to the newest
version that supports the repo's compiler and Oxlint stack.

This is not a dependency-only update. A disposable dependency spike found five
source migrations: consolidated import paths, PascalCase CLI constructors,
PascalCase Config constructors, the `ByteSize` replacement for `FileSystem.MiB`,
and reversed success/failure tuple ordering in `Array.partition` and
`Effect.partition`. The migration should preserve the concurrency-aware
`Effect.partition`, but replace the same-typed `Array.partition` split with
explicit named arrays so a future tuple-order change cannot silently invert it.

## Current state

- Effect 4.0.0 is the first stable v4 release. Its release notes say synchronized
  Effect packages share one version, consolidated modules import from paths such
  as `effect/http` and `effect/cli`, and platform integrations such as
  `@effect/platform-node` remain separate:
  <https://github.com/Effect-TS/effect/releases>
- Stable v4 requires TypeScript 5.9 or newer and recommends TypeScript 7. The
  repo already pins TypeScript 7.0.2 with strict checking, so the recommended
  compiler is already in place and does not need another migration.
- `package.json:23-40` currently pins the Effect family to `4.0.0-rc.112`,
  `@effect/tsgo` independently to `0.47.1`, and Vitest to `^4.1.9`:

  ```json
  "@effect/platform-node": "4.0.0-rc.112",
  "effect": "4.0.0-rc.112",
  "@effect/tsgo": "0.47.1",
  "@effect/vitest": "4.0.0-rc.112",
  "vitest": "^4.1.9"
  ```

- `@effect/vitest@4.0.0` requires Vitest `>=5.0.0 <6.0.0`. Vitest 5 requires
  Node `^22.12.0 || ^24.0.0 || >=26.0.0` and a direct Vite peer in
  `^6.4.0 || ^7.0.0 || ^8.0.0`:
  <https://www.npmjs.com/package/@effect/vitest?activeTab=versions>
- The migration spike resolved and installed this compatible set successfully:
  `effect@4.0.0`, `@effect/platform-node@4.0.0`, `@effect/vitest@4.0.0`,
  `vitest@5.0.3`, and `vite@8.3.2`. Vitest 5 started under both halves of the
  existing test script; the failures were caused by Effect source incompatibilities,
  not a Vitest blocker.
- Upgrade independently versioned `@effect/tsgo` from `0.47.1` to `0.48.0`.
  Its supported-version table explicitly includes the repo's existing
  TypeScript 7.0.2, Oxlint 1.86.0, and oxlint-tsgolint 7.0.2003 pins, so those
  already-current companion tools stay unchanged. Version 0.48.0 is also the
  first available version in this stack whose recommended preset warns on
  unstable and experimental API use and provides scoped allowlists.
- Keep those recommended diagnostics active. Gauntlet intentionally adopts the
  Effect CLI, HTTP, and process module families, so configure the Effect language
  service in `tsconfig.json` with `diagnostics: false` and set
  `allowedUnstableApis` to exactly `effect/cli`, `effect/http`, and
  `effect/process`. Oxlint remains the sole diagnostics authority while the
  language service supplies editor refactors, quick fixes, quickinfo, and
  completions. The 0.48.0 TypeScript/Oxlint integration was spiked against the
  stable dependency set and honors the allowlist even with LSP diagnostics off;
  unrelated unstable APIs and all experimental APIs remain Oxlint warnings.
- The current checkout has a green baseline at `2e3f49f`: `bun run typecheck`,
  `bun run lint`, and `bun run test` pass. The test baseline is 189 source tests,
  95 script/Convoy tests, and the installer shell test.
- `package.json:19` deliberately runs source tests with Bun's Vitest runtime and
  script/Convoy tests with Vitest's Node runtime. Preserve this split.
- `scripts/check-effect-pin.ts:1-5` still describes the `rc` dist-tag and must be
  made release-neutral after the stable pin lands.

### Source migration inventory

The final release removed the `effect/unstable` prefix for the consolidated
areas. Change only the import source; keep imported identifiers and runtime
logic intact.

| Old import prefix | New import prefix | Files |
|---|---|---|
| `effect/unstable/cli/` | `effect/cli/` | `scripts/lint-house-style.ts`, `src/cli/config.ts`, `src/cli/login.ts`, `src/cli/main.ts`, `src/cli/upgrade.ts` |
| `effect/unstable/http/` | `effect/http/` | `src/cli/update-check.test.ts`, `src/cli/update-check.ts`, `src/cli/upgrade.ts`, `src/linear/linear.test.ts`, `src/linear/linear.ts` |
| `effect/unstable/process/` | `effect/process/` | `scripts/bundle.ts`, `scripts/check-import-cycles.ts`, `scripts/lint-house-style.ts`, `scripts/live-gate-compiled.ts`, `src/github/github.ts`, `src/target/git.ts`, `src/test-support/git.fixture.ts` |

Stable constructors are PascalCase:

| Old call | New call | Locations |
|---|---|---|
| `Argument.string(...)` | `Argument.String(...)` | `scripts/lint-house-style.ts`, `src/cli/config.ts`, `src/cli/login.ts`, `src/cli/main.ts` |
| `Flag.integer(...)` | `Flag.Int(...)` | `src/cli/main.ts` |
| `Flag.string(...)` | `Flag.String(...)` | `src/cli/main.ts` |
| `Flag.boolean(...)` | `Flag.Boolean(...)` | `src/cli/main.ts` |
| `Flag.choice(name, literals)` | `Flag.Literals(name, literals)` | `src/cli/main.ts` |
| `Config.string(...)` | `Config.String(...)` | `scripts/bundle.ts`, `scripts/live-gate-compiled.ts`, `scripts/lint-house-style.ts`, `src/cli/config.ts`, `src/config/settings.ts`, `src/config/standards-manifest.ts` |
| `Config.redacted(...)` | `Config.Redacted(...)` | `src/linear/linear.ts` |

Do not PascalCase combinators such as `Argument.optional`, `Argument.variadic`,
`Flag.optional`, `Flag.withDefault`, or `Flag.withDescription`. In particular,
retain both boolean flags' explicit `Flag.withDefault(false)` behavior.

`FileSystem.MiB` no longer exists. Add `import * as ByteSize from
"effect/ByteSize"` and replace it with `ByteSize.mebibytes` in:

- `src/workspace/source-context.ts:28` — one-mebibyte source cap.
- `src/target/working-tree.ts:26` — ten-mebibyte untracked-file cap.
- `src/target/working-tree.test.ts:90-94` — exact-cap and over-cap byte arrays;
  retain `Number(...)` around the branded bigint for `Uint8Array` lengths.

Stable partition functions return successes first and failures second. Keep
`Effect.partition` where it is doing real concurrent Effect collection, and
swap its destructuring:

```ts
// src/run/finder-execution.ts:223 and :245, current
const [failed, completed] = yield* Effect.partition(...)

// stable target
const [completed, failed] = yield* Effect.partition(...)
```

```ts
// src/stages/judgment/resolution.ts:192, current
const [unknown, known] = Array.partition(
  output?.decisions ?? [],
  (decision) => HashSet.has(validIndexes, decision.index)
    ? Result.succeed(decision)
    : Result.fail(decision),
)

// stable target: avoid a positional tuple whose two sides have the same type
const known: Array<ReportedJudgment> = []
const unknown: Array<ReportedJudgment> = []
for (const decision of output?.decisions ?? []) {
  if (HashSet.has(validIndexes, decision.index)) known.push(decision)
  else unknown.push(decision)
}
```

Remove the now-unused `effect/Result` import from `resolution.ts`. This explicit
single-pass split is smaller than the Result-based partition, names the domain
outcomes directly, and no longer relies on the ordering of two arrays that both
contain `ReportedJudgment`. The existing finder-execution and
judgment-resolution tests detect incorrect classification; preserve their
assertions rather than changing expected output.

### Alternatives considered

- Do not add compatibility aliases for `effect/unstable/*`. Stable v4 provides
  no compatibility exports, and aliases would hide rather than complete the
  migration at runtime and bundle boundaries.
- Do not replace Effect CLI, HTTP, or process modules with Node/Bun primitives.
  They are already the repo's typed adapter boundaries; reimplementing them
  expands behavior and tests without reducing this migration.
- Do not disable the new unstable/experimental API diagnostics just to make the
  migration pass. Keep the 0.48.0 recommended preset and allow only the three
  intentionally adopted unstable module families. This preserves warnings for
  any new unstable or experimental dependency while making the existing
  architecture explicit.
- Do not run the same diagnostics through both the language service and Oxlint.
  Patch both integrations, but set the plugin's `diagnostics` option to `false`;
  this keeps editor refactors and quick fixes without duplicate findings.
- Do not retain `Array.partition` merely for consistency with
  `Effect.partition`: the former's two outputs have the same element type and
  gain nothing from the Result encoding; the latter provides concurrency and
  distinct success/failure types.

Repo conventions to preserve:

- Read `CLAUDE.md` and use the shared `effect` skill before editing Effect code.
- Effect packages are exact, synchronized pins; independently versioned
  `@effect/tsgo` is also pinned exactly and upgraded only with a supported
  TypeScript/Oxlint/tsgolint combination.
- Imports include explicit modules rather than the `effect` barrel.
- No behavior, error-channel, CLI-default, or test-expectation change is intended.

## Commands you will need

| Purpose | Command | Expected on success |
|---|---|---|
| Runtime gate | `node --version` | Node `^22.12.0`, `^24.0.0`, or `>=26.0.0` |
| Install | `bun install` | exit 0; prepare patches TypeScript and Oxlint |
| Effect tooling | `node_modules/.bin/effect-tsgo --version` | reports `tsgo v0.48.0` |
| Focused partition tests | `bun --bun vitest run src/run/finder-execution.test.ts src/stages/judgment/resolution.test.ts` | all tests pass |
| Typecheck | `bun run typecheck` | exit 0, no diagnostics |
| Lint and Effect pins | `bun run lint` | exit 0; no warnings; reports Effect pins exact at 4.0.0 |
| Full test suite | `bun run test` | exit 0; all three commands pass |
| Compiled binary test | `bun run test:upgrade-compiled` | exit 0; bundles once and passes the compiled updater test |
| Compiled CLI help | `dist/gauntlet --help` | exit 0; help renders |
| Compiled CLI version | `dist/gauntlet --version` | exit 0; version is `v0.0.0-dev` |

## Suggested executor toolkit

- Use the `effect` skill for general Effect code and testing conventions. Its
  stable-v4 import paths, constructors, and TSGO policy were refreshed while
  this plan was written; the installed `effect@4.0.0` package remains the final
  API authority.
- Use the official stable release notes for package topology and migration facts:
  <https://github.com/Effect-TS/effect/releases>.
- Use the `@effect/vitest` package page for its Vitest 5 compatibility contract:
  <https://www.npmjs.com/package/@effect/vitest?activeTab=versions>.

## Scope

**In scope** (the only implementation files you should modify):

- Dependency and Effect tooling state: `package.json`, `bun.lock`,
  `tsconfig.json`, `.oxlintrc.json`.
- Shared Effect pack guidance: `.convoy/packs/effect/README.md`,
  `.convoy/packs/effect/oxlintrc.json`.
- Scripts: `scripts/bundle.ts`, `scripts/check-effect-pin.ts`,
  `scripts/check-import-cycles.ts`, `scripts/lint-house-style.ts`,
  `scripts/live-gate-compiled.ts`.
- CLI: `src/cli/config.ts`, `src/cli/login.ts`, `src/cli/main.ts`,
  `src/cli/update-check.test.ts`, `src/cli/update-check.ts`,
  `src/cli/upgrade.ts`.
- Config and integrations: `src/config/settings.ts`,
  `src/config/standards-manifest.ts`, `src/github/github.ts`,
  `src/linear/linear.test.ts`, `src/linear/linear.ts`.
- Runtime behavior: `src/run/finder-execution.ts`,
  `src/stages/judgment/resolution.ts`, `src/target/git.ts`,
  `src/target/working-tree.test.ts`, `src/target/working-tree.ts`,
  `src/test-support/git.fixture.ts`, `src/workspace/source-context.ts`.
- Migration record and status: `plans/001-upgrade-effect-4-stable.md`,
  `plans/README.md`.

**Out of scope** (do NOT touch, even though they look related):

- Historical research notes or ADRs containing old links; they record the state
  at the time they were written.
- TypeScript 7.0.2, Oxlint 1.86.0, and oxlint-tsgolint 7.0.2003 upgrades; all
  three are already current and explicitly supported by `@effect/tsgo@0.48.0`.
- Refactoring, API cleanup, or test expectation changes unrelated to compilation
  against Effect 4.0.0.
- Publishing, deployment, or a live review run.

## Git workflow

- Branch: `codex/effect-4-stable`.
- Commit as one logical migration after all gates pass. Match the repo's concise,
  descriptive style, for example: `Effect 4.0.0 stable`.
- Do NOT push or open a PR unless the operator instructs it.

## Steps

### Step 1: Update the synchronized dependency set

Edit `package.json` in one operation so the manifest never represents the
incompatible intermediate pairing of `@effect/vitest@4` with Vitest 4:

```json
"@effect/platform-node": "4.0.0",
"effect": "4.0.0",
"@effect/tsgo": "0.48.0",
"@effect/vitest": "4.0.0",
"vite": "^8.3.2",
"vitest": "^5.0.3"
```

Leave TypeScript, Oxlint, oxlint-tsgolint, and every unrelated dependency
unchanged. Change the existing prepare script from
`effect-tsgo patch --no-typescript --oxlint` to
`effect-tsgo patch --typescript --oxlint`: TypeScript supplies the editor
language-service features while Oxlint remains the CI diagnostics owner.

Add the local TSGO schema and Effect language-service plugin to `tsconfig.json`:

```json
{
  "$schema": "./node_modules/@effect/tsgo/schema.json",
  "compilerOptions": {
    "plugins": [
      {
        "name": "@effect/language-service",
        "diagnostics": false,
        "allowedUnstableApis": ["effect/cli", "effect/http", "effect/process"]
      }
    ]
  }
}
```

Replace `.oxlintrc.json`'s generic remote Oxc schema with the version-matched
`./node_modules/@effect/tsgo/oxlint-schema.json`. This changes editor validation
only; preserve every extend, rule, and override.

`diagnostics: false` disables only the language service's duplicate diagnostic
display; it does not disable the recommended Oxlint rules. Do not add
`allowedExperimentalApis`, disable either Oxlint stability rule, or repeat the
allowlist in Oxlint config. Run `bun install` once to regenerate `bun.lock` and
apply both patches; do not hand-edit the lockfile. Confirm the lock resolves the
three synchronized Effect packages to exactly 4.0.0, TSGO to exactly 0.48.0,
and a compatible Vite 8/Vitest 5 pair.

**Verify**:

```sh
node --version
bun install
node_modules/.bin/effect-tsgo --version
rg -n 'effect-tsgo patch --typescript --oxlint|@effect/tsgo/(schema|oxlint-schema)\.json|"diagnostics": false|allowedUnstableApis' package.json tsconfig.json .oxlintrc.json
rg -n '4\.0\.0-rc\.112|"@effect/tsgo": "0\.47\.1"|"vitest": "\^4\.' package.json bun.lock
```

Expected: the Node version satisfies Vitest 5; install exits 0; the final search
prints no matches (its exit status 1 is expected); TSGO reports `tsgo v0.48.0`;
the configuration search finds both patch integrations, both local schemas,
single-owner diagnostics, and the scoped allowlist.

### Step 2: Move consolidated imports out of `effect/unstable`

Apply the three prefix replacements from the source migration inventory to the
named files. Preserve every imported namespace/type and all runtime logic.
`@effect/platform-node/*` imports remain unchanged because platform packages are
still separate in stable v4.

**Verify**:

```sh
rg -n 'effect/unstable/(cli|http|process)' src scripts -g '*.ts'
```

Expected: no matches (exit status 1).

### Step 3: Adopt the final constructor and ByteSize APIs

Apply every constructor mapping in the inventory. Then import `effect/ByteSize`
in the three size-cap files and replace each `FileSystem.MiB(n)` with
`ByteSize.mebibytes(n)`. Remove `FileSystem` imports only where the module is no
longer otherwise used; both production size-cap files still use the FileSystem
service and should keep that import.

Do not change descriptions, metavariables, defaults, environment-variable names,
mebibyte values, or numeric boundary expectations.

**Verify**:

```sh
rg -n 'Argument\.string|Flag\.(integer|string|boolean|choice)|Config\.(string|redacted)|FileSystem\.MiB' src scripts -g '*.ts'
```

Expected: the search prints no matches (exit status 1).

### Step 4: Make both decision splits explicit under the stable API

In `src/run/finder-execution.ts`, change both destructurings to
`[completed, failed]`, leaving the returned `{ failed, completed }` object shape
unchanged.

In `src/stages/judgment/resolution.ts`, replace the `Array.partition` call with
the explicit `known`/`unknown` single-pass loop from Current state and remove the
now-unused `effect/Result` import. Do not duplicate the predicate, change the
decision order within either output, or alter the notes emitted for unknown
indexes.

**Verify**:

```sh
bun --bun vitest run src/run/finder-execution.test.ts src/stages/judgment/resolution.test.ts
bun run typecheck
```

Expected: both test files pass with their existing expectations; typecheck exits
0 after every source migration is in place.

### Step 5: Refresh the pin guidance and run every gate

Rewrite only the stale introductory comment in `scripts/check-effect-pin.ts`.
It should say to update Effect and sibling packages to the same exact version;
remove references to `effect@rc`, the `rc` dist-tag, and v4 not yet being latest.
Do not alter the pin-checking program.

Run the full verification sequence. If a test exposes an intentional Vitest 5
behavior change, first confirm that the test itself violates the documented
Vitest 5 contract; do not casually rewrite expectations just to make it green.

**Verify**:

```sh
bun run typecheck
bun run lint
bun run test
bun run test:upgrade-compiled
dist/gauntlet --help
dist/gauntlet --version
git diff --check
```

Expected: every command exits 0; lint has zero warnings and reports exact Effect
4.0.0 pins; all tests pass; `test:upgrade-compiled` performs the only bundle and
passes; compiled CLI help renders; the dev binary reports `gauntlet v0.0.0-dev`;
`git diff --check` prints nothing.

After all checks pass, update the plan's row in `plans/README.md` from `TODO` to
`DONE`.

## Test plan

- Do not add tests by default. This is a compatibility migration with no intended
  behavior change, and the existing suite covers the affected CLI, Config,
  filesystem caps, HTTP integrations, process integrations, finder execution,
  and judgment resolution.
- Treat `src/run/finder-execution.test.ts` and
  `src/stages/judgment/resolution.test.ts` as the explicit regression tests for
  the success/failure and known/unknown classification. Their existing
  expectations must pass unchanged.
- Treat `src/target/working-tree.test.ts` as the boundary regression for the
  ten-mebibyte `ByteSize` conversion. Its exact-cap and one-byte-over cases must
  still pass unchanged.
- The authoritative verification is `bun run test`: all 189 source tests, all 95
  script/Convoy tests, and the installer test must pass.

## Done criteria

- [x] `package.json` and `bun.lock` resolve `effect`,
      `@effect/platform-node`, and `@effect/vitest` to exactly `4.0.0`.
- [x] Vitest is `^5.0.3`, Vite is declared directly as `^8.3.2`, and
      `@effect/tsgo` is exactly `0.48.0`; TypeScript, Oxlint, and
      oxlint-tsgolint retain their supported existing pins.
- [x] `tsconfig.json` configures `@effect/language-service` with only the three
      intentional unstable module families and `diagnostics: false`;
      `.oxlintrc.json` uses the TSGO schema; prepare patches TypeScript and
      Oxlint; recommended Oxlint stability diagnostics remain enabled and lint
      reports no stability warnings.
- [x] Searches find no `4.0.0-rc.112`, migrated `effect/unstable/*` paths,
      lowercase migrated constructors, or `FileSystem.MiB` in `package.json`,
      `bun.lock`, `src/`, or `scripts/`.
- [x] Both `Effect.partition` destructurings name successes first;
      judgment resolution uses explicit named arrays with no `effect/Result`
      import; existing regression tests pass without expectation changes.
- [x] `bun run typecheck`, `bun run lint`, `bun run test`,
      `bun run test:upgrade-compiled`, and both compiled CLI smoke commands exit
      0.
- [x] `git diff --check` exits 0.
- [x] No files outside the in-scope list are modified.
- [x] `plans/README.md` status row is `DONE`.

## STOP conditions

Stop and report back (do not improvise) if:

- An in-scope source excerpt or dependency arrangement has drifted since commit
  `2e3f49f` in a way that changes the mapping in this plan.
- The available Node runtime does not satisfy Vitest 5's supported range.
- `bun install` cannot resolve the exact Effect 4.0.0 family with Vitest 5 and a
  compatible direct Vite peer, or TSGO 0.48.0 rejects the existing supported
  TypeScript/Oxlint/tsgolint pins.
- Patched Oxlint does not honor the scoped unstable-API allowlist with language
  service diagnostics disabled, or a remaining stability warning names an API
  outside the three explicitly adopted families.
- Any listed replacement API is absent from the installed stable package, or a
  listed old API still appears required after the planned migration.
- Correcting a failure appears to require a behavior change, a changed test
  expectation, or a file outside the in-scope list.
- Either classification regression test still fails after applying the exact
  finder destructuring and judgment loop described above.
- A verification command fails twice after a reasonable, in-scope correction.

## Maintenance notes

- Review the finder partition change as semantic, not cosmetic: a swapped tuple
  reverses completed and failed finders. Judgment resolution deliberately uses
  named arrays instead of another positional tuple.
- The CLI, HTTP, and process areas are consolidated into `effect`, but their APIs
  may still carry `@stability unstable`; the repo's exact Effect pins contain
  that risk. Do not loosen them to a range.
- The shared `effect` skill and Convoy Effect pack README were updated while this
  plan was written: stable v4 paths/constructors are now authoritative, the
  language service and Oxlint are both patched with Oxlint as the single
  diagnostics owner, recommended stability diagnostics stay enabled, and
  intentionally adopted unstable modules use scoped `allowedUnstableApis`
  entries rather than a blanket rule disable.
