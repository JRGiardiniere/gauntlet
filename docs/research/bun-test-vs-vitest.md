# Could Gauntlet's test suite move from `vitest` to `bun test`?

- **Date:** 2026-08-20
- **Bun under test:** `1.4.0` (pinned dev binary, verified with `bun --version`)
- **Vitest under test:** `4.1.11` (installed; `package.json` pins `^4.1.9`)
- **`@effect/vitest` under test:** `4.0.0-rc.110`, matching `effect@4.0.0-rc.110`
- **Scope:** the 47-file / 334-test suite under `src/**/*.test.ts`, run today via
  `vitest run` (script `test` in `package.json`).
- **Primary sources:** `bun test --help` behavior on the pinned 1.4.0 binary,
  https://bun.com/docs/cli/test, https://bun.com/blog/bun-v1.4, the
  `@effect/vitest` source read directly from
  `node_modules/.bun/@effect+vitest@4.0.0-rc.110+.../node_modules/@effect/vitest/src/{index,internal/internal}.ts`,
  and empirical experiments run in the scratchpad
  (`/private/tmp/.../scratchpad/bun-test-exp`) against the exact pinned `bun`
  binary and this repo's actual installed `node_modules` (symlinked in, not
  copied). No secondary write-ups were used for the load-bearing claims. This
  is a new file; no existing repo file was modified.

## Bottom line

**No — not without dropping `@effect/vitest`, and there is no drop-in
replacement for it today.** `@effect/vitest` doesn't just import the public
`vitest` API (`describe`/`it`/`expect`) — it reaches into vitest's internal
test-runner module (`V.TestRunner.getCurrentSuite`) to implement `it.effect`,
`it.layer`, and the Effect/TestClock/Scope wiring the whole suite depends on
(all 47 files use `@effect/vitest`; 3 files additionally drive
`effect/testing/TestClock` directly). That's a structural coupling, not a
surface one — it can't be shimmed by aliasing a handful of functions.

Bun 1.4 does ship something concrete here: `bun test` intercepts
`import ... from "vitest"` and rebinds it onto Bun's own test globals (proven
below — `it` from `"vitest"` is literally `bun`'s `test` function under `bun
test`). But that shim only covers the public surface
(`describe`/`it`/`expect`/`beforeEach`/`vi`/etc.) — it has no `TestRunner`
export at all, so `@effect/vitest` crashes immediately (`TypeError: undefined
is not an object (evaluating 'V.TestRunner.getCurrentSuite')`), confirmed by
running the repo's actual `@effect/vitest` under `bun test` (Experiment 3).

There is no official Effect integration for `bun:test`. `@effect/vitest` is
the only package published under the `@effect/*` npm scope for test-runner
integration; the two community alternatives that exist
(`effect-bun-test@0.3.0`, `@domir/bun-test@2.0.0`) target Effect v3 and an
Effect v4 **beta** respectively, not the pinned v4 **rc.110**, and neither is
an Effect-TS-org package — using either would mean depending on a
single-maintainer package (against the "no new runtime dependencies without
strong cause" house rule) to reimplement test infrastructure this project
already has working.

Even setting the blocker aside, the potential win is small: vitest already
parallelizes across files (this suite: 47 files / 334 tests / 6.36s wall per
`vitest run`, workers already saturating multiple cores — 16.8s user vs 6.76s
wall). Bun 1.4's headline test-runner features (`--isolate`/`--no-isolate`,
`--changed`, `--timings`, `--retry`/`--rerun-each`) target problems this suite
doesn't visibly have: it's not flaky, it's not I/O-shard-bound, and file-level
isolation is vitest's default too. The realistic upside is startup/transform
overhead (vitest's own numbers show `transform 1.23s` + `import 9.33s`
overlapped across workers, vs. Bun's directly-executed TypeScript with no
transform step) — plausible but unmeasured here since the suite can't
actually run under `bun test` today.

**Recommendation: stay on vitest.** Migrating would mean either (a) waiting
for/building an official Effect v4 `bun:test` integration that doesn't exist,
or (b) hand-rolling the `it.effect`/`it.layer`/`TestClock` plumbing this repo
gets for free from `@effect/vitest` today — real engineering cost for a
runner swap whose main measurable benefit (test wall time) is already small
relative to total `vitest run` overhead, and whose main claimed benefit
(fewer moving parts) doesn't hold once you count "reimplement the Effect test
harness" as a moving part. Revisit only if Effect Inc. ships an official
`bun:test` adapter for v4, or if `vitest` startup/transform overhead becomes
an actual measured bottleneck (it isn't now: 6.36s for 334 tests).

## Q1 — What does `@effect/vitest` actually couple to in vitest's API surface?

Read directly from
`node_modules/.bun/@effect+vitest@4.0.0-rc.110+55be7d2f723fe580/node_modules/@effect/vitest/src/index.ts`
and `src/internal/internal.ts`:

- `export * from "vitest"` — re-exports the entire public vitest API
  (`describe`, `it`, `expect`, `beforeEach`, `vi`, snapshot matchers, etc.)
  unchanged, so any file doing `import { describe, it, expect } from
  "@effect/vitest"` is really just importing vitest through a pass-through,
  plus the Effect-aware extras.
- The Effect-aware extras (`it.effect`, `it.live`, `it.layer`,
  `it.scoped`-equivalent via Scope) are built in `internal.ts` on top of:
  - `V.it` (`vitest`'s `TestAPI`) — used as the base test function, wrapped
    in a `Proxy` (comment in source: *"do not bind: binding would strip
    vitest's static helpers (e.g. `describe.each`)"* — i.e. it depends on
    vitest's `it`/`describe` carrying extra static methods beyond a plain
    callable).
  - `V.describe`, `V.beforeAll`, `V.afterAll`, `V.beforeEach` — standard
    hook registration, public API.
  - `V.expect.addEqualityTesters([...])` — public API, used for custom
    equality (`addEqualityTesters`).
  - **`V.TestRunner.getCurrentSuite`** — this is the load-bearing one. It is
    not part of vitest's documented/exported public API surface for
    consumers; it's used internally by `@effect/vitest` to walk the current
    suite's collected tasks (`collectTasks`, used by `it.layer` to hook
    shared-layer setup/teardown into the right suite). This is a real
    coupling to vitest's runner internals, not just its test-definition API.
  - `V.TestContext`, `V.TestOptions`, `V.SuiteCollector` types — public
    TypeScript types, not runtime coupling.
- `peerDependencies` pin `vitest: ">=4.1.0 <5.0.0"` and
  `effect: "^4.0.0-rc.110"` — `@effect/vitest` is versioned in lockstep with
  vitest major versions, another sign it treats vitest as a foundation, not
  an interchangeable backend.

**Could this be shimmed on `bun:test`?** Not the `TestRunner.getCurrentSuite`
part — that would require Bun to expose an equivalent runner-internals hook
(it doesn't; see Q3), or `@effect/vitest` to be forked/patched to avoid it
(non-trivial: `it.layer`'s shared-layer memoization across a describe block
depends on knowing "what tests belong to the current suite", which is exactly
what that call answers). The public-surface half (`describe`/`it`/`expect`)
is exactly what Bun's `vitest`-import shim already covers — so the failure is
narrow but structural: one internal API call, with no public equivalent.

## Q2 — Does an official/credible Effect v4 integration for `bun:test` exist?

**No.** Checked directly:

- `npm view @effect/bun-test` → `404 Not Found`. No such package exists under
  the `@effect/*` scope.
- Registry search (`registry.npmjs.org/-/v1/search?text=effect bun-test` and
  `scope:effect bun`) turns up no Effect-TS-org test-runner package for Bun.
  `@effect/platform-bun` and `@effect/sql-sqlite-bun` exist (platform/SQL
  drivers) but neither is a test-runner integration.
- Two **community** packages exist, neither matching this repo's pin:
  - `effect-bun-test@0.3.0` (maintainer `_cevr`, GitHub-published) —
    `peerDependencies: { effect: ">=3.19.0", bun: "*" }`. Targets Effect
    **v3**, not v4.
  - `@domir/bun-test@2.0.0` (single maintainer `domir`) —
    `peerDependencies: { effect: "^4.0.0-beta.70", "@types/bun": "^1.3.14" }`.
    Targets an Effect v4 **beta**, and this repo pins `4.0.0-rc.110` — a
    single-maintainer package with no visible relationship to the Effect-TS
    org, which is exactly the kind of "new runtime dependency" the project's
    "no new runtime dependencies without strong cause" rule (`CLAUDE.md`) is
    meant to gate.

Nothing here is an Anthropic/Effect-TS-endorsed, actively-maintained,
v4-rc-compatible replacement for `@effect/vitest`.

## Q3 — Can `bun test` run this suite as-is or with small config?

**As-is: no.** Empirically (Experiment 3): running the repo's real
`@effect/vitest` import under `bun test` fails immediately with

```
TypeError: undefined is not an object (evaluating 'V.TestRunner.getCurrentSuite')
    at .../node_modules/@effect/vitest/dist/internal/internal.js:19:27
```

But the underlying mechanism is more interesting than "vitest just isn't
there." Bun 1.4 does ship a real `import ... from "vitest"` interception
under `bun test` — confirmed empirically, not documented explicitly in the
blog post or CLI docs in these terms (the blog post's only stated vitest
claim is that *real* vitest can run atop Bun's runtime — `"vitest runs under
Bun, including --coverage, with the threads and forks pools"` — a different,
narrower claim about vitest-the-tool executing on the bun runtime, not about
`bun test` absorbing vitest source files):

- Plain vitest usage (`describe`/`it`/`expect`) imported from `"vitest"` and
  run with `bun test` **passes** (Experiment 1) — with zero `vitest` or
  `@effect/vitest` present in `node_modules` at all in that experiment.
- Inspecting what's actually bound (Experiment 2): `it.name` under this
  import is `"bound test"` — i.e. vitest's `it`, as resolved by `bun test`,
  is Bun's own `test` function, not real vitest. Enumerating the module's
  exports gives exactly Bun's jest/vitest-compatible test globals:
  `describe, it, test, expect, expectTypeOf, beforeAll/afterAll/beforeEach,
  vi, jest, mock, spyOn, setSystemTime, onTestFinished, xdescribe, xit,
  xtest` — **no `TestRunner` export**. This is Bun's built-in
  Jest/Vitest-API-compatible shim (the same one that lets a Jest/Vitest test
  file often run unmodified under `bun test`), not real vitest source being
  loaded.
- Confirmed separately: running plain `bun -e 'require.resolve("vitest")'`
  (outside `bun test`) resolves to a real, network-fetched vitest package in
  Bun's install cache — that's Bun's ordinary module resolution doing an
  auto-install for a bare specifier with no local `node_modules`, unrelated
  to the `bun test`-specific shim. Under `bun test` specifically, the import
  is intercepted before that resolution happens.

**Net:** `bun test` can transparently run files that only use vitest's
*public, common* surface. It cannot run this suite, because every one of the
47 test files goes through `@effect/vitest`, which needs the one export
(`TestRunner.getCurrentSuite`) the shim doesn't have. No flag or config
changes this — it's a missing capability in Bun's shim, not a suite
configuration issue.

## Q4 — If migrated, which Bun 1.4 test features would matter for this suite, honestly quantified?

Baseline: `vitest run` → 47 files, 334 tests, **6.36s wall**
(`transform 1.23s, setup 1.38s, import 9.33s, tests 19.85s` — overlapped
across workers, not additive; `time` shows 16.82s user / 9.95s system / 6.76s
real, i.e. ~4x CPU parallelism already in play).

- **`--parallel` / worker-per-core:** Not a new win — vitest is *already*
  running this suite across multiple worker processes (the CPU-time-vs-
  wall-time ratio above proves it). Bun's default `bun test` behavior is
  comparable in kind (isolate-by-default, one worker per core); this is a
  wash, not an upgrade.
- **`--isolate` / `--no-isolate`:** Bun's docs describe `--no-isolate` as a
  perf *opt-out* (share one worker's module registry across files instead of
  resetting per file) — the inverse of a feature this suite is missing.
  Vitest's default (isolated environments per file, poolable workers) is
  already the safer default Bun also ships. No plausible win either
  direction without first proving cross-file state bleed is safe here, which
  nothing in this investigation suggests is needed.
- **`--changed`:** Genuinely useful for iteration speed on a local machine
  (run only tests touched by uncommitted changes), but it's a workflow
  convenience, not a suite-architecture win — and vitest has an equivalent
  (`vitest --changed`) already, so this isn't bun-test-exclusive leverage.
- **`--timings` (duration-aware `--shard` scheduling):** Only pays off at a
  scale where sharding across CI machines matters. At 6.36s wall for the
  whole suite, there's nothing to shard — this feature solves a problem
  Gauntlet's suite doesn't have.
- **`--retry` / `--rerun-each`:** Solves flaky-test triage. Nothing in this
  investigation found evidence of flakiness in this suite (`TestClock` is
  used specifically so time-dependent tests are deterministic and never
  auto-advance — the opposite of a suite that needs retries to paper over
  timing flakiness).
- **Fake timers (`jest.useFakeTimers()`):** Bun's fake-timer story is a
  `jest`-shaped global timer mock. This suite already has a purpose-built,
  more precise mechanism for the same problem — `effect/testing/TestClock`,
  driven explicitly per-test with `TestClock.adjust(...)` (used directly in
  3 files: `src/harness/invoke.test.ts`, `src/run/finder-execution.test.ts`,
  and referenced in `src/cli/main.test.ts`) and implicitly by every
  `it.effect` test's default Effect test environment. Swapping to Bun's
  global fake timers would be a downgrade in precision (global mutable timer
  state vs. an Effect service that's part of the same effect being tested)
  for a capability the suite doesn't lack.

**Realistic quantifiable win, if the blocker were resolved:** likely
startup/transform overhead only. Vitest's own breakdown shows `transform
1.23s` (esbuild/vite transform pass, not needed for Bun's native TS
execution) and part of the `import 9.33s` figure is module-graph resolution
overhead vitest's pool workers pay. Bun's direct TS execution has no
transform step and (per the 1.4 blog) fast native ESM resolution. But this is
speculative — it could not be measured here because the suite cannot run
under `bun test` at all (Q3), so there's no empirical before/after number to
report, only a plausible mechanism.

## Q5 — What would be lost?

- **`it.effect` / `it.live` / `it.layer` and the whole `@effect/vitest`
  ergonomics layer** — the mechanism this entire suite's test-authoring style
  depends on (`describe`/`it.effect` pairs returning `Effect.gen` bodies,
  layer-scoped shared setup via `it.layer`). No drop-in equivalent exists for
  Effect v4 on `bun:test` (Q2). This is the actual blocker, not a nice-to-have.
- **`TestClock` integration via `@effect/vitest`'s Scope/Effect-environment
  wiring** — while `effect/testing/TestClock` itself is an Effect module, not
  a vitest module, its use inside `it.effect` tests is orchestrated by
  `@effect/vitest`'s Scope handling. Losing `@effect/vitest` means
  re-plumbing that by hand for every test.
- **Vitest 4 features already in use via the `V.*` re-export**: `expect`
  matchers, `vi.*` mocking, snapshot support (`toMatchSnapshot` etc., if used
  — not confirmed used in this suite but available), `describe.each`/`it.each`
  static helpers (explicitly called out in `@effect/vitest`'s own source
  comment as something a naive rebind would break).
  All of this exists today because it's wired through vitest's runner (and,
  for the Effect-aware helpers, through `@effect/vitest`'s coupling to that
  runner) — none of it is verified to exist for `bun:test` + Effect v4.
- **Vitest's watch-mode UI / reporters** — not something this project's
  CI-shaped test invocation (`vitest run`, non-watch) currently exercises
  directly, so this is a smaller loss in practice than it would be for a
  watch-driven dev workflow, but it's still tooling maturity that would need
  to be rebuilt or gone without on `bun test`.

## Experiments (scratchpad, `bun-test-exp/`)

1. `import { describe, it, expect } from "vitest"` run with `bun test`, no
   `node_modules` present at all → **1 pass**. Proves `bun test` intercepts
   bare `"vitest"` imports rather than requiring the real package.
2. Same file, logging `Object.keys(V)` and `it.name` → exports are exactly
   Bun's jest/vitest-compatible globals (`describe, it, test, expect,
   expectTypeOf, beforeAll, afterAll, beforeEach, vi, jest, mock, spyOn,
   setSystemTime, onTestFinished, xdescribe, xit, xtest` — no `TestRunner`
   export); `it.name === "bound test"`, i.e. it is Bun's own `test` function,
   not real vitest's `it`.
3. **Reproduced against this repo's real `node_modules`** (symlinked, not
   copied): `import { describe, it, expect } from "@effect/vitest"` plus
   `it.effect(...)`, run under `bun test` → immediate crash,
   `TypeError: undefined is not an object (evaluating
   'V.TestRunner.getCurrentSuite')` at
   `@effect/vitest/dist/internal/internal.js:19:27`. This is the concrete,
   reproducible blocker.
4. Confirmed `bun -e 'require.resolve("vitest")'` (outside `bun test`)
   resolves a real, separately-cached vitest package from Bun's global
   install cache — a different code path (ordinary bare-specifier
   auto-install) from the `bun test`-specific import interception seen in
   Experiments 1–2.
5. Timed the current suite: `time bun run test` → `vitest run`, 47 files,
   334 tests, `Duration 6.36s` reported by vitest, `16.82s user / 9.95s
   system / 6.76s real` per `time`, confirming existing multi-core
   parallelism in the current setup (used as the Q4 baseline).

## Complexity tradeoff

Moving off vitest here isn't "swap the test binary" — it's "reimplement the
Effect-v4 test-authoring layer this repo depends on in every one of its 47
test files, for a runner with no official Effect integration, to chase a
startup-overhead win that hasn't been measured because it can't be measured
without doing that reimplementation first." That's real, uncapped engineering
cost (a bespoke `it.effect`/`it.layer`/Scope shim, maintained in-house, with
no upstream to track for Effect-v4 API churn) against a speculative,
unmeasured win on a suite that already finishes in 6.36s. Per this project's
"personal tool, no speculative safeguards" posture (`CLAUDE.md`) — that same
minimalism principle argues *against* taking on the reimplementation, not for
it: there's no measured or structural problem with the current vitest setup
to justify the cost.
