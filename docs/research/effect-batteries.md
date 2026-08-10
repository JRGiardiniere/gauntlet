# Effect v4 batteries inventory

- **Ticket:** [#2 — Research: Effect v4 batteries inventory](https://github.com/JRGiardiniere/gauntlet/issues/2) (part of #1)
- **Status:** Research findings. Nothing here is approved architecture.
- **Date:** 2026-08-09

## Question

What does the current Effect v4 beta ship that Gauntlet should use instead of
hand-rolling? Inventory `effect` and `@effect/*`, and map each capability onto
Gauntlet's concrete needs: a CLI with subcommands/options/presets, config
resolution, schema-validated persisted artifacts, bounded agent fan-out with
layered deadlines and clean interruption, run logging and post-hoc reports, and
deterministic tests without real sleeps.

## Method and ground truth

Every claim below was read out of source, not recalled:

- **Primary:** `effect@4.0.0-beta.90` source at
  `/Users/johngiardiniere/projects/cloudflare-hub/node_modules/effect/src` —
  the pin cloudflare-hub uses. Also `@effect/platform-node`,
  `@effect/platform-node-shared`, `@effect/vitest` at the same pin.
- **Drift check:** `effect@4.0.0-beta.106` (the current `beta` dist-tag as of
  2026-08-09, 16 betas ahead) unpacked from npm and diffed module-by-module
  against beta.90. See [§13](#13-beta90--beta106-drift).
- **House docs:** `cloudflare-hub/docs/effect-house-style.md` and
  `docs/effect-v4-patterns.md`.
- **Official docs:** <https://effect.plants.sh/> (the v4 documentation site) and
  the Effect blog beta recaps.

**The headline structural fact:** there is no `@effect/cli`, no
`@effect/platform`, no `@effect/schema`, no `@effect/opentelemetry`-required
path, and no `@effect/ai-*` in what you need. In v4 these are **subpath exports
of the single `effect` package**: `effect/unstable/cli`, `effect/unstable/process`,
`effect/Schema`, `effect/unstable/observability`, `effect/unstable/ai`,
`effect/testing`. The only separate packages Gauntlet needs are
`@effect/platform-node` (Node implementations of the platform services) and
`@effect/vitest` (test harness). Do not reach for v3 package names.

---

## 0. Decision summary

| Gauntlet need | Effect ships | Module | Verdict |
|---|---|---|---|
| CLI: subcommands, options, help, version | `Command`, `Flag`, `Argument` | `effect/unstable/cli` | **Use** |
| CLI: presets (`gauntlet run medium`) | subcommands + `withDefault` + `Config` fallback | `effect/unstable/cli` | **Use** (a preset is a `Flag.choice`, not a framework feature) |
| CLI: shell completions | `Completions` (bash/zsh/fish) | `effect/unstable/cli` | **Use** — free |
| CLI: machine-readable output | `CliOutput.Formatter` (a `Context.Reference`) | `effect/unstable/cli` | **Use** |
| Config: env + defaults + validation | `Config` (Schema-backed), `ConfigProvider` | `effect/Config` | **Use** |
| Config: **files** (JSON/YAML/TOML) | only `.env`, dir-tree, and in-memory providers | `effect/ConfigProvider` | **Partially use** — hand-roll the file read, feed `fromUnknown` |
| Config precedence flag > env > file > default | `layerAdd` + `Flag.withFallbackConfig` | both | **Use** |
| Schema-validated persisted artifacts | v4 `Schema` (`Struct`, `Class`, `fromJsonString`) | `effect/Schema` | **Use** |
| JSON Schema for model-facing tool params | `Schema.toJsonSchemaDocument` | `effect/Schema` | **Use** — one schema, two consumers |
| **Atomic** writes on disk | ❌ nothing | `effect/FileSystem` | **Hand-roll** — `writeFileString` to a sibling temp + `rename` |
| File locking | ❌ nothing (only `open` flag `"wx"`) | `effect/FileSystem` | **Hand-roll** |
| Filesystem, paths, temp dirs, watch | full `FileSystem` + `Path` services | `effect/FileSystem`, `effect/Path` | **Use** |
| Subprocess with kill-on-interrupt | `ChildProcess` + `ChildProcessSpawner` | `effect/unstable/process` | **Use** |
| Terminal (columns, readLine, key events) | `Terminal`, `Stdio` | `effect/Terminal`, `effect/Stdio` | **Use** |
| Key/value persistence | `KeyValueStore` + `toSchemaStore` | `effect/unstable/persistence` | **Partially use** — its FS backend is non-atomic |
| Bounded fan-out | `forEach`/`all` `{concurrency}`, `Semaphore`, `Pool` | `effect/Effect` | **Use** |
| One failed lens must not kill siblings | `Effect.partition`, `Effect.all({mode:"result"})` | `effect/Effect` | **Use** — see [§14](#14-surprises) |
| Layered deadlines (startup / first-response / total) | `Effect.timeout`, `timeoutOption`, `timeoutOrElse`, `Stream.timeout` | `effect/Effect`, `effect/Stream` | **Use** — composed by you, not a preset |
| Clean interruption incl. subprocess teardown | `Scope`, `acquireRelease`, process-group kill | core + `unstable/process` | **Use** |
| Retry policy | `Schedule` + `Effect.retry({times,schedule,while,until})` | `effect/Schedule` | **Use** |
| Provider/model fallback ladder | `ExecutionPlan` + `Effect.withExecutionPlan` | `effect/ExecutionPlan` | **Use** — see [§14](#14-surprises) |
| Structured run logging to a file | `Logger.toFile`, `Logger.formatJson`, `annotateLogs` | `effect/Logger` | **Use** |
| Metrics for post-hoc reports | `Metric` + `Metric.snapshot` / `Metric.dump` | `effect/Metric` | **Use** — no backend required |
| Tracing | `Effect.withSpan`, `Otlp.layer` (HttpClient only) | core + `unstable/observability` | **Use**, gated off by default |
| Deterministic time in tests | `TestClock` (on by default in `it.effect`) | `effect/testing`, `@effect/vitest` | **Use** |
| Property tests / schema round-trip tests | `FastCheck` re-export, `TestSchema`, `it.prop` | `effect/testing` | **Use** |
| Model-agnostic LLM interface | `LanguageModel`, `Tool`, `Toolkit`, `Chat` | `effect/unstable/ai` | **Partially use** — see [§10](#10-ai-the-model-agnostic-seam) |
| Durable run / resume | `Workflow`, `Activity`, `DurableDeferred` | `effect/unstable/workflow` | **Evaluate** — see [§11](#11-durability-unstableworkflow) |

---

## 1. CLI — `effect/unstable/cli`

`@effect/cli` v3 is gone; this is a rewrite folded into core. Barrel exports:
`Argument`, `CliError`, `CliOutput`, `Command`, `Completions`, `Flag`,
`GlobalFlag`, `HelpDoc`, `Param`, `Primitive`, `Prompt`.
Docs: <https://effect.plants.sh/cli/> · Source:
<https://github.com/Effect-TS/effect/tree/main/packages/effect/src/unstable/cli>

### What exists

```ts
Command.make(name, config, handler)   // config is a record of Flag/Argument
Command.withHandler(handler)          // attach later      (beta.90)
Command.withSubcommands([...])        // nested or grouped: { group, commands }
Command.withSharedFlags({...})        // npm-style flags valid before/after the subcommand
Command.withGlobalFlags([...])        // custom global flags scoped to a subtree
Command.withAlias / withDescription / withExamples / withHidden
Command.provide / provideSync / provideEffect   // inject Layers into the handler
Command.run({ version })              // reads argv from the Stdio service
Command.runWith(cmd, { version })     // explicit ReadonlyArray<string>
```

A `Command` is itself an `Effect<ContextInput, never, CommandContext<Name>>`,
so a subcommand handler can `yield* parentCommand` to read the parent's parsed
config in a typed way. The run Effect's channels are:

```
Effect<void, E | CliError.CliError, R | FileSystem | Path | Terminal | ChildProcessSpawner | Stdio>
```

— i.e. exactly what `@effect/platform-node`'s `NodeServices.layer` provides
(`ChildProcessSpawner | Crypto | FileSystem | Path | Stdio | Terminal`).
`--help`, `--version`, `--completions`, `--log-level` are prepended automatically
by `runWith` via `GlobalFlag.BuiltIns`; there is no runMain integration in the
module, so the boundary is yours: `Command.run(...).pipe(Effect.provide(AppLayer), NodeRuntime.runMain)`.

**Params.** `Flag` and `Argument` are both thin specializations of one `Param`
abstraction. Constructors: `string`, `boolean` (flags only), `integer`, `float`,
`date`, `choice`, `choiceWithValue`, `path`, `file`, `directory`, `redacted`,
`fileText`, `fileParse`, `fileSchema`, `keyValuePair`, `none`.
Combinators: `withAlias`, `withDescription`, `withMetavar`, `withHidden`,
`optional`, `withDefault`, `withFallbackConfig`, `withFallbackPrompt`, `map`,
`mapEffect`, `mapTryCatch`, `atLeast`/`atMost`/`between`, `filter`/`filterMap`,
`orElse`, `withSchema`, and `Argument.variadic`.

**Errors and rendering.** `CliError` is a closed union —
`UnrecognizedOption`, `DuplicateOption`, `MissingOption`, `MissingArgument`,
`InvalidValue`, `UnknownSubcommand`, `ShowHelp`, `UserError` — with
"did you mean?" suggestions built in, and `ShowHelp` setting
`Runtime.errorExitCode` to 1 or 0 appropriately. `CliOutput.Formatter` is a
`Context.Reference` with a default, overridable via `CliOutput.layer(myFormatter)`.

**Completions.** `Completions.generate(exeName, "bash"|"zsh"|"fish", descriptor)`,
wired to the built-in `--completions` flag. It prints the script; there is no
installer.

### Mapping to Gauntlet

`gauntlet run medium --pr 123` decomposes cleanly:

- `gauntlet` = root `Command.make("gauntlet")`, `.withSubcommands([run, resume, report, ...])`.
- `medium` is a **preset**. Two honest options, both native:
  1. `Argument.choice("level", ["low","medium","high","xhigh","max"])` — one
     `run` subcommand, level as a positional. Simple, and the preset table stays
     a plain data structure keyed by the literal.
  2. `Command.withSubcommands` with one command per preset — better help text,
     more surface.
  Recommendation: **(1)**, because a preset is a lookup into a frozen
  `ReviewPlan` table, not a distinct code path. Effect ships no "preset"
  concept and shouldn't — `withDefault` + `Config` fallback + a literal union
  is the whole mechanism.
- `--pr 123` = `Flag.integer("pr").pipe(Flag.optional)`.
- **Presets should be schema-validated on the way in**: `Flag.withSchema` or
  `Argument.choice` gives you the literal union at the type level, which is what
  the frozen-configuration protection in STARTING-POINT.md wants.

**Verdict: Use.** No maturity red flags — every symbol carries `@since 4.0.0`
with runnable examples, and there are zero `TODO`/`FIXME`/`@experimental`
markers anywhere under `unstable/cli`. The `unstable/` path is a stability
promise, not a quality signal; it means the API may move between betas (it did —
see [§13](#13-beta90--beta106-drift)).

---

## 2. Config — `effect/Config`, `effect/ConfigProvider`

Docs: <https://effect.plants.sh/configuration/>

**`Config` is Schema-backed.** Every primitive is sugar over
`Config.schema<T,E>(codec: Schema.Codec<T,E>, path?)`. Primitives:
`string`, `nonEmptyString`, `number`, `finite`, `int`, `boolean`, `duration`,
`port`, `logLevel`, `redacted`, `url`, `date`, `literal`, `literals`.
Structural: `all`, `map`, `mapOrFail`, `orElse`, `withDefault`, `option`,
`nested`, `succeed`, `fail`, plus `Config.Array` and `Config.Record` schema
helpers (both accept JSON *or* `"a,b,c"` / `"k=v,k=v"` string forms).
`Config.Wrap` / `Config.unwrap` exist for wrapping a whole record of configs.

One important semantic: `Config.withDefault` only catches *missing-data*
`SchemaError`s. A value that is present but invalid still fails. That is the
right behavior for Gauntlet and worth relying on deliberately.

**Providers that ship:** `fromEnv` (the default, installed as a
`Context.Reference` so it's always available), `fromUnknown` (any in-memory JS
value), `fromDotEnvContents`, `fromDotEnv` (needs `FileSystem`), `fromDir`
(directory tree as config — the k8s ConfigMap shape, needs `FileSystem | Path`),
and `make` for custom.

**There is no JSON/YAML/TOML file provider.** This is the one real gap for
Gauntlet's "files + env + flags" requirement.

**Composition:** `ConfigProvider.orElse(a, b)` falls back only when `a` returns
`undefined` (a source *error* propagates — good). `layer(provider)` replaces the
active provider; `layerAdd(provider, { asPrimary })` composes with the current
one. `mapInput` / `constantCase` bridge camelCase schema keys to
`SCREAMING_SNAKE_CASE` env vars.

### Mapping to Gauntlet

Three-tier resolution (flags > env > file > default) is expressible today:

```ts
// file tier: read + parse yourself, then hand it to fromUnknown
const fileProvider = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const raw = yield* fs.readFileString(configPath)          // typed PlatformError
  return ConfigProvider.fromUnknown(yield* Schema.decodeEffect(GauntletConfigFile)(JSON.parse(raw)))
})

// env wins over file
const ConfigLayer = ConfigProvider.layer(fileProvider).pipe(
  Layer.provideMerge(ConfigProvider.layerAdd(ConfigProvider.fromEnv(), { asPrimary: true })),
)

// flags win over both, per-parameter
const level = Flag.choice("level", LEVELS).pipe(
  Flag.withFallbackConfig(Config.literals(LEVELS)("GAUNTLET_LEVEL")),
  Flag.withDefault("medium"),
)
```

`Flag.withFallbackConfig` is the load-bearing piece: it makes flag→env→default
precedence a per-parameter declaration rather than a hand-written merge
function, and it means the CLI and the config system share one validation path.

**Verdict: Use, with ~20 lines of hand-rolled file loading.** Do NOT hand-roll
precedence merging or env parsing. Do decode the config file with a `Schema`
before handing it to `fromUnknown` so a malformed file is a typed failure at a
known point, not a mystery `MissingData` three layers down.

**Gotcha (beta.106):** empty config strings are now treated as missing data.
That changes whether `GAUNTLET_LEVEL=""` hits your default or fails.

---

## 3. Schema and persisted artifacts — `effect/Schema`

Docs: <https://effect.plants.sh/schema/>

This is the **effect-smol rewrite**, not v3 `@effect/schema`. Do not trust
memory here.

- Type is `Codec<Type, Encoded, DecodingServices, EncodingServices>` — four
  parameters, with a separate type-level `Iso` channel for lossless round-trips.
- Declaration: `Schema.Struct({ ... })`.
- **Key optionality is two distinct things**: `optionalKey(S)` = exact optional
  (key may be absent, type is `S`); `optional(S)` = `optionalKey(UndefinedOr(S))`.
  For JSON on disk you almost always want `optionalKey` — JSON never carries a
  literal `undefined`. (This is house rule 16's `optionalKey` note, and it
  generalizes beyond Cloudflare envelopes.)
- Entry points: `decodeUnknownEffect` / `decodeEffect` (and `Exit`/`Option`/
  `Result`/`Promise`/`Sync` variants), plus encode mirrors, `is`, `asserts`.
- Classes: `Schema.Class`, `Schema.TaggedClass`, `Schema.ErrorClass`,
  `Schema.TaggedErrorClass` (yieldable — `yield* new NotFound({ id })`),
  `Schema.Opaque`.
- JSON: `Schema.fromJsonString(schema)` is the "parseJson" equivalent — decode a
  JSON string straight into the domain type and encode back to a string. Also
  `Schema.Json`, `fromFormData`, `fromURLSearchParams`.
- Defaults: `withConstructorDefault`, `withDecodingDefaultKey`, and friends.
- Filters: a very large built-in library (`isPattern`, `isUUID`, `isTrimmed`,
  `isMinLength`, `isBetween`, `isUnique`, `isDateValid`, …) plus `check`,
  `refine`, `brand`.
- Errors: `SchemaError` (a `Data.TaggedError` wrapping an `Issue`) whose
  `.message` is `issue.toString()`; `SchemaIssue` gives the structured union
  (`MissingKey`, `InvalidType`, `Pointer`, `Composite`, `AnyOf`, …) if you want
  to render your own.
- **`Schema.toJsonSchemaDocument(schema)`** → a draft-2020-12 JSON Schema
  document. `JsonSchema.ts` converts between draft-07 / 2020-12 / OpenAPI 3.0 /
  3.1 dialects.
- **`Schema.toStandardSchemaV1(schema)`** → a Standard Schema v1 adapter, so
  anything that speaks Standard Schema (including most tool-calling SDKs)
  consumes an Effect Schema directly.

### Atomic writes — the one real gap

There is **no atomic-write helper and no file-locking API** anywhere in
`effect`. `FileSystem.writeFileString` maps to a single `fs.writeFile`
(verified in `@effect/platform-node-shared/src/NodeFileSystem.ts`).

You do get the parts: `writeFileString`, `rename` (a direct `NFS.rename`, atomic
on POSIX within one filesystem), `makeTempFile`/`makeTempFileScoped`,
`makeTempDirectoryScoped`, and `open(path, { flag: "wx" })` for exclusive
create.

**Hand-roll this, and get the sibling-directory detail right:**

```ts
// Effect ships neither of these; ~15 lines total.
const writeAtomic = Effect.fn("gauntlet.artifacts.write_atomic")(
  function* (path: string, contents: string) {
    const fs = yield* FileSystem.FileSystem
    // MUST be a sibling of `path`, not os.tmpdir() — rename across
    // filesystems is EXDEV, and makeTempFile defaults to os.tmpdir().
    const tmp = `${path}.tmp.${crypto.randomUUID()}`
    yield* Effect.acquireRelease(
      fs.writeFileString(tmp, contents),
      () => fs.remove(tmp, { force: true }).pipe(Effect.ignore),
    )
    yield* fs.rename(tmp, path)
  },
)
```

The trap worth naming loudly: `FileSystem.makeTempFile()` defaults to
`OS.tmpdir()`. Using it as the staging file for an atomic artifact write will
work on a dev laptop and fail with `EXDEV` on a machine where `/tmp` is a
separate mount. Stage in the artifact directory.

STARTING-POINT.md's "completion files are removed before work and committed by
rename" protection is exactly this primitive, and Effect gives you the `rename`
half but not the discipline.

### Mapping to Gauntlet

- One `Schema` per persisted artifact (`ReviewPlan`, `AgentOutcome`, `Candidate`,
  `Evaluation`, `ReviewHandoff`, `DurableRun`, `DeliveryReceipt`), written via
  `Schema.fromJsonString` + `writeAtomic`, read via `decodeEffect` on resume.
  That satisfies "every persisted artifact is decoded before reuse" for free.
- **Answer to the open question "can one schema serve domain, persistence, and
  model-facing tool contracts?"** — mostly yes, and this is a strong argument
  for Effect Schema over zod here: `toJsonSchemaDocument` derives the
  model-facing tool parameter schema from the same declaration as the domain
  type, and `unstable/schema/VariantSchema` exists for the cases where the
  persisted and domain shapes genuinely diverge. Use it as a projection, not as
  a forced single form.
- Schema is **not** the identity mechanism. "Cryptographically tied to
  artifacts" needs a checksum you compute yourself; Schema validates shape, not
  provenance.

---

## 4. Platform — FileSystem, Path, Terminal, Stdio, subprocess, persistence

### `effect/FileSystem`

Full service: `access`, `copy`, `copyFile`, `chmod`, `chown`, `exists`, `link`,
`makeDirectory`, `makeTempDirectory(+Scoped)`, `makeTempFile(+Scoped)`, `open`
(scoped `File` handle with `seek`/`read`/`write`/`sync`/`truncate`),
`readDirectory`, `readFile`, `readFileString`, `readLink`, `realPath`, `remove`,
`rename`, `sink`, `stat`, `stream`, `symlink`, `truncate`, `utimes`, `watch`,
`writeFile`, `writeFileString`. Errors are `PlatformError` wrapping a
`BadArgument | SystemError`, where `SystemError` is tagged with one of
`NotFound | AlreadyExists | PermissionDenied | Busy | TimedOut | …`.

That tagged `SystemError` union is what house rule 22 ("never collapse an
existence check into its absent-value default") is built on — you can
discriminate `NotFound` from `PermissionDenied` without inventing your own
classification.

Also ships `makeNoop`/`layerNoop` for tests.

### `effect/Path`, `effect/Terminal`, `effect/Stdio`

`Path` is the usual surface plus `fromFileUrl`/`toFileUrl` returning Effects.
`Terminal` is a real interactive service: `columns`, `rows`, `readLine`,
`display`, and `readInput` returning a scoped `Queue.Dequeue<UserInput>` with
key modifiers — plus a `QuitError` for Ctrl-C. `Stdio` gives `args`, `stdout`,
`stderr` sinks and a `stdin` stream, with a `layerTest()` for tests.

### `effect/unstable/process` — subprocess

`ChildProcess.make` supports three forms including a tagged-template form
(``ChildProcess.make`git status` ``). A `Command` is itself an
`Effect<ChildProcessHandle, PlatformError, ChildProcessSpawner | Scope>`.
Options: `cwd`, `env`, `extendEnv`, `shell`, `detached` (defaults **true** on
POSIX), `stdin`/`stdout`/`stderr` as `"pipe"|"inherit"|"ignore"|Stream|Sink`,
`additionalFds`, `killSignal`, `forceKillAfter`. Piping via `pipeTo`.

The `ChildProcessSpawner` service gives `spawn`, `exitCode`, `string`, `lines`,
`streamString`, `streamLines`.

**The Node implementation does the hard part for you** (verified in
`@effect/platform-node-shared/src/NodeChildProcessSpawner.ts`):

- spawn is wrapped in `Effect.acquireRelease`; the release finalizer kills the
  **process group** (`process.kill(-pid, sig)` on POSIX, `taskkill /T /F` on
  Windows) on scope close **including on interruption**;
- `forceKillAfter` escalates SIGTERM → SIGKILL via `Effect.timeoutOrElse`;
- a signal-killed process surfaces as a typed `PlatformError`, not a null exit
  code.

This directly answers STARTING-POINT.md's "should timeout interrupt and await
cleanup, or return before an uncooperative abort settles?" — the machinery for
"interrupt, escalate, and await" already exists and is the default. **Use it.**

### `effect/unstable/persistence`

- `KeyValueStore`: `get`/`set`/`remove`/`clear`/`size`/`modify`/`has`/`isEmpty`,
  with `layerMemory`, `layerFileSystem(dir)` (one file per key),
  `layerSql`, `layerStorage`, a `prefix` combinator, and **`toSchemaStore(store,
  schema)`** for a typed JSON store.
- `Persistence` / `PersistedCache` / `PersistedQueue`: schema-encoded `Exit`
  storage keyed by `Persistable` requests, with memory / KVS / Redis / SQL
  backings and TTL support.
- `RateLimiter`: with memory and Redis stores, and an *adaptive* consume mode.

**Verdict: partially use.** `KeyValueStore.layerFileSystem` + `toSchemaStore` is
a tempting one-liner for Gauntlet's artifact store, but its `set` is a plain
`writeFileString` — **not atomic**, which conflicts with the
"committed-by-rename" protection. Either use it only for non-critical caches, or
wrap your own `KeyValueStore` implementation whose `set` is the atomic write
above. `PersistedCache` is worth a look for the finder-cache behavior in the
protection inventory.

---

## 5. Concurrency, deadlines, interruption

Docs: <https://effect.plants.sh/concurrency/>

**Fan-out.** `Concurrency = number | "unbounded" | "inherit"`.
`Effect.forEach(items, f, { concurrency, discard })`.
`Effect.all(effects, { concurrency, discard, mode: "default" | "result" })`.
Note beta.90 has **no** `batching` or `concurrentFinalizers` options — those are v3.

**Failure isolation.** Two first-class answers to "one failed lens cannot reject
successful siblings":

- `Effect.all(effects, { concurrency: N, mode: "result" })` → collects
  `Result`s instead of short-circuiting;
- `Effect.partition(items, f, { concurrency: N })` → `[failures, successes]`,
  runs every effect, **never fails**.

`Effect.partition` is the closer match for finder fan-out, because coverage loss
is data you must report, not an error to swallow.

**Deadlines.** At beta.90 the timeout family is exactly three:
`Effect.timeout` (fails `TimeoutException`), `Effect.timeoutOption`
(→ `Option.none`), `Effect.timeoutOrElse` (lazily-built fallback; interrupts
the source first). **`timeoutFail` and `timeoutTo` do not exist** — v3 names.

Gauntlet's three-layer deadline model maps like this — note that Effect gives
you the primitives and you compose the policy:

| Gauntlet deadline | Composition |
|---|---|
| startup deadline | `Effect.timeout(acquireSession, startupBudget)` around the acquisition step only |
| first-response watchdog | `Stream.timeout(events, firstResponseBudget)` — "ends the stream if it does not produce a value within the duration", i.e. an **inter-emission idle timeout**, which is the truthful definition of "never began responding". Or race a `Deferred` completed by the first event. |
| tool / bash deadline | `Effect.timeout` on the individual tool effect, or `ChildProcess`'s own `forceKillAfter` |
| total invocation budget | outer `Effect.timeout` on the whole scoped invocation; scope finalizers (including the process-group kill) run during the interrupt |

Because `timeout` interrupts and the interrupt propagates through `Scope`
finalizers, "timeout interrupts and awaits cleanup" is the default, and getting
"return before the abort settles" would require deliberately forking.

**Interruption.** `Effect.interrupt`, `interruptible`, `uninterruptible`,
`uninterruptibleMask`, `interruptibleMask`, `onInterrupt`.
Race: `race` (first *success*), `raceFirst` (first to settle), `raceAll`,
`raceAllFirst`. **House rule 12 applies: `Effect.race` prefers first success, so
a fast failure waits for the slow branch — use `raceFirst` for watchdogs.**
Fork variants are `forkChild` / `forkIn` / `forkScoped` / `forkDetach` — there is
**no plain `Effect.fork`, no `forkDaemon`, no `forkAll`** at this pin.

**Lifetime.** `acquireRelease`, `addFinalizer`, `ensuring`, `onExit`, `onError`,
`Effect.scoped`.

**Coordination primitives.** `Semaphore` (counting),
**`PartitionedSemaphore`** (permits keyed by `K` — independent pools per key),
`Pool` (fixed and TTL-elastic resource pools), `FiberSet`, `FiberMap` (one fiber
per key, replaces on `set`), `FiberHandle` (single slot), `Latch`, `RcMap`
(refcounted scoped resources, torn down at zero), `Deferred`, `Queue`, `PubSub`,
plus a full `Tx*` STM family.

**`ExecutionPlan`** (`effect/ExecutionPlan`) deserves separate billing —
see [§14](#14-surprises).

**Verdict: Use throughout. Hand-roll nothing here.** Every item in
STARTING-POINT.md §"Structured concurrency" (hand-managed Promise sets, broad
`Promise.all`, custom semaphores, scattered `AbortController`, ambiguous
background-task ownership) has a direct, better-typed replacement.

---

## 6. Schedule and retry

Docs: <https://effect.plants.sh/scheduling/>

**beta.90:** constructors `exponential`, `fibonacci`, `fixed`, `spaced`,
`windowed`, `duration`, `during`, `cron`, `elapsed`, `recurs`, `forever`;
composition `both*` (AND) / `either*` (OR) / `andThen`; `collectWhile` (a single
metadata-driven predicate replacing v3's `whileInput`/`whileOutput`);
`take`, `reduce`, `collectInputs`/`collectOutputs`; `addDelay`, `modifyDelay`,
`jittered`, `delays`; `tap`/`tapInput`/`tapOutput`; `map`, `passthrough`.

`Effect.retry` and `Effect.repeat` take either a bare `Schedule` or an options
object:

```ts
interface Retry.Options<E> {
  while?:  (error: E) => boolean | Effect<boolean, any, any>
  until?:  (error: E) => boolean | Effect<boolean, any, any>
  times?:  number
  schedule?: Schedule<any, E, any, any>
}
```

**House rule 13 restated and confirmed at this pin:** a standalone unbounded
schedule is not capped by `times` unless `times` is used alone — bound the
schedule itself (`Schedule.spaced(d).pipe(Schedule.take(n))`) or use `times`
without a schedule. Defects and interrupts are never retried.

`Schedule.CurrentMetadata` is a `Context.Reference<Metadata>` exposing
`{ input, output, duration, attempt, start, now, elapsed, elapsedSincePrevious }`
to the effect being retried — so "which attempt am I on" is available for
logging without threading a `Ref`.

### Mapping to Gauntlet

- Warmup retry, provider backoff, durable-run polling: `Schedule` + bounded
  `retry`.
- **"Do not retry after context-length stop or insufficient remaining budget"**
  is `retry({ while: (e) => isRetryable(e) })` over a tagged error union, which
  is exactly the "typed retry predicates" hypothesis in STARTING-POINT.md. Model
  the terminal modes as `Data.TaggedError` tags and the retry policy becomes a
  compiler-checked exhaustive match.
- Bounded missing-emit correction: `Effect.repeat({ until, times: 1 })` rather
  than a hand-rolled loop counter.

**Verdict: Use.** But see [§13](#13-beta90--beta106-drift) — `Schedule` was
the single most heavily reworked module between beta.90 and beta.106.

---

## 7. Logging, metrics, tracing

Docs: <https://effect.plants.sh/observability/>

**Logger.** Formatters `formatSimple`, `formatLogFmt`, `formatStructured`,
`formatJson`. Console loggers `consolePretty`, `consoleLogFmt`,
`consoleStructured`, `consoleJson`. Plus `defaultLogger`, `tracerLogger`
(emits logs as span events), `batched(...)`, and **`Logger.toFile(path)`** — a
dual, scoped, batched file logger that flushes on scope close and needs only
`FileSystem` + `Scope`. Install with
`Logger.layer(loggers, { mergeWithExisting })`.
Level via the `References.MinimumLogLevel` reference (there is **no**
`Effect.withMinimumLogLevel` combinator at this pin).
Annotations: `Effect.annotateLogs`, `annotateLogsScoped`, `Effect.withLogSpan`.

**Metric.** `counter`, `gauge`, `histogram`, `frequency`, `summary`,
`summaryWithTimestamp`, `timer`; `mapInput`, `withConstantInput`,
`withAttributes`; boundary helpers `linearBoundaries` / `exponentialBoundaries`.
Export: **`Metric.snapshot: Effect<ReadonlyArray<Snapshot>>`** and
**`Metric.dump: Effect<string>`**. Plus `Metric.enableRuntimeMetricsLayer` for
fiber-runtime metrics.

**Tracer.** `Effect.withSpan`, `withSpanScoped`, `useSpan`, `currentSpan`,
`annotateSpans`, `annotateCurrentSpan`, `linkSpans`; `Tracer.externalSpan`,
`Tracer.DisablePropagation`, `Tracer.MinimumTraceLevel`.
`Effect.fn("name")` = `fnUntraced` + automatic span.

**Exporters (`effect/unstable/observability`).** `Otlp.layer({ baseUrl, resource,
headers, ...intervals })` merges `OtlpLogger` + `OtlpMetrics` + `OtlpTracer`
against `/v1/logs`, `/v1/metrics`, `/v1/traces`. Requires only
`HttpClient.HttpClient` — **no `@effect/opentelemetry`, no NodeSdk, no
`@opentelemetry/*` dependency**. `PrometheusMetrics.layerHttp` also ships.

> **Divergence from the hub house style, deliberate.** `effect-house-style.md`
> rule for cloudflare-hub is "`@effect/opentelemetry` NodeSdk, never the in-core
> `unstable/observability` OTLP layers." That rule exists because hub runs
> Node-in-a-Cloudflare-Sandbox and needs `AsyncLocalStorageContextManager`
> parenting across a specific async boundary. Gauntlet is a local CLI. The
> in-core `Otlp.layer` is the lighter, dependency-free choice here, and
> STARTING-POINT.md already asks "which observability backend, if any, is
> justified for a small local tool?" — the honest answer is **none by default**:
> gate `Otlp.layer` behind a config and collapse to `Layer.empty` when unset.

### Mapping to Gauntlet

- **Run logging:** `Logger.toFile(runDir/run.log)` composed with
  `Logger.formatJson`, merged for the run's scope, plus `Effect.annotateLogs`
  carrying run id / lens / seat / reviewed commit. That is the entire "run
  journal" requirement, with no hand-rolled writer.
- **Post-hoc reports:** `Metric.snapshot` at the end of a run gives cache hits,
  termination modes, coverage failures, and retry counts as structured data you
  can serialize into the run artifact — **with zero observability backend**.
  This is the single best answer to STARTING-POINT.md's "are structured logs
  enough initially?" — yes, plus a metrics snapshot in the artifact.
- **Content-leak caution stands:** annotate with ids and paths, never prompt or
  diff content. Effect has `Redacted` and a `Redactable` protocol; use
  `Config.redacted` for credentials so they cannot be logged accidentally.

**Verdict: Use Logger and Metric now. Wire the tracer, gate the exporter off.**

---

## 8. Testing

Docs: <https://effect.plants.sh/testing/>

**`effect/testing`** exports exactly four modules:

- **`TestClock`** — `make`, `layer(options)`, `adjust(duration)`,
  `setTime(ms)`, `testClockWith`, `withLive(effect)`, and inspectable pending
  `sleeps`.
- **`TestConsole`** — `layer`, plus `logLines` / `errorLines` to assert on
  captured output.
- **`TestSchema`** — `Asserts` / `Decoding` / `Encoding` helper classes for
  schema round-trip property tests.
- **`FastCheck`** — a straight `export * from "fast-check"`.

There is no `TestRandom` / `TestServices` / `TestContext` at this pin.

**`@effect/vitest`** (pinned `4.0.0-beta.90`):
`it.effect` (provides `Scope` automatically — **there is no `it.scoped`**),
`it.live`, `it.layer(layer, { memoMap, timeout, excludeTestServices })`,
`it.flakyTest`, `it.prop(name, arbitraries, fn)` for property tests driven by
`fast-check` or `Schema` arbitraries, plus `.skip`/`.only`/`.each`/`.fails`.

**`TestClock` and `TestConsole` are installed by default.** Internally:
`const TestEnv = Layer.mergeAll(TestConsole.layer, TestClock.layer())`, merged
into every `it.effect` unless `excludeTestServices: true`.

### Mapping to Gauntlet

"Deterministic tests without real sleeps" is **already the default** — you get
it by using `it.effect`. The requirement inverts: the discipline is remembering
that the TestClock *never auto-advances*, so a test exercising a deadline must
either fork the sleeping effect and `TestClock.adjust`, or use `it.live` when
real elapsed time is itself the behavior under test. **A delay test that does
neither hangs** (house rule 18 — this has bitten the hub already).

For the "deterministic scripted agent adapter" protection: build it as a Layer
implementing the `AgentRunner` tag, with a `Ref`-backed script. Effect's
contribution is that event *timing* becomes expressible — script an adapter that
sleeps on the TestClock, and the first-response watchdog becomes testable
without a real provider or a real second.

**Verdict: Use. Hand-roll only the scripted agent adapter itself.**

---

## 9. Stream — the Pi event bridge

`Stream` is large; the relevant capabilities:

- **Bridging callbacks:** `Stream.callback`, `Stream.fromQueue`,
  `Stream.fromPubSub`, `Stream.fromAsyncIterable`, `Stream.fromEventListener`,
  `Stream.fromReadableStream`. The STARTING-POINT hypothesis ("adapt callbacks
  into a private `Queue`, expose a `Stream`") is directly supported —
  `Stream.fromQueue` over a `Queue` you feed from Pi's callbacks, with the
  `Queue`'s capacity as your backpressure answer.
- **Deadlines:** `Stream.timeout` (idle timeout — ends the stream if no value
  within the duration) and `Stream.timeoutOrElse` (switch to a fallback stream;
  note the fallback is *not* itself timed).
- **Concurrency:** `mapEffect(f, { concurrency })`, `mergeAll`, `partition`,
  `broadcast`, `share`, `race`.
- **Shaping:** `grouped`, `groupedWithin`, `aggregateWithin`, `debounce`,
  `throttle`, `splitLines`, `decodeText`, `paginate`, `runFold`.
- **Interruption:** `haltWhen`, `interruptWhen`, `onExit`, `ensuring`.

**Verdict: Use `Stream` for the Pi event bridge specifically**, because you want
an idle timeout and interruption semantics on it. Elsewhere, prefer plain
`Effect` — a `Stream` where an `Effect` would do is the classic Effect
over-abstraction, and STARTING-POINT.md is right to ask the question.

---

## 10. AI — the model-agnostic seam

`effect/unstable/ai` · Docs: <https://effect.plants.sh/ai/>

18 modules: `LanguageModel`, `Model`, `Chat`, `Tool`, `Toolkit`, `Prompt`,
`Response`, `EmbeddingModel`, `Tokenizer`, `Telemetry`, `AiError`,
`IdGenerator`, `ResponseIdTracker`, `McpServer`, `McpSchema`,
`AnthropicStructuredOutput`, `OpenAiStructuredOutput`.

- **`LanguageModel`** is a `Context.Service` with `generateText`,
  `generateObject`, `streamText`. `LanguageModel.make({ generateText, streamText,
  codecTransformer })` adapts *any* provider's hooks into the shared service, so
  swapping models is swapping a `Layer`. It runs the tool-call loop internally
  with configurable `concurrency`, supports `toolChoice`
  (`auto`/`required`/`none`/pinned/`oneOf`), tool-call **approval** workflows
  (`needsApproval`), and **`disableToolCallResolution`** to observe raw tool
  calls without executing them.
- **`Tool` / `Toolkit`** define tools as Schema contracts
  (`parameters`/`success`/`failure`), with `ProviderDefined` and `Dynamic`
  variants; execution validates params, runs the handler, and encodes the result.
- **`Model`** wraps a provider `Layer` with `ProviderName`/`ModelName` tags —
  a `Model` *is* a `Layer`.
- **`Chat`** keeps prompt history in a `Ref` and has `makePersisted` /
  `layerPersisted` over `BackingPersistence` — durable, resumable transcripts.
- **`Telemetry`** emits OpenTelemetry **GenAI semantic-convention** (`gen_ai.*`)
  attributes and offers a `CurrentSpanTransformer` service.
- **`Tokenizer`** — provider token counting + prompt truncation.
- **`AiError`** — a tagged error with a `reason` union covering transport,
  provider response, rate limit, auth, content policy, invalid request, invalid
  output, unsupported schema, tool failure, unknown, with HTTP-response→reason
  helpers.
- **`McpServer`** — a full MCP **server** implementation (stdio and HTTP layers,
  `registerToolkit`/`registerResource`/`registerPrompt`, plus server→client
  `elicit`). Note: server only, not an MCP *client*.

**What is NOT here:** no provider packages. `node_modules/@effect/` contains only
`opentelemetry`, `platform-node`, `tsgo`, `vitest` — **no `@effect/ai-anthropic`
or `@effect/ai-openai`**. `AnthropicStructuredOutput`/`OpenAiStructuredOutput`
are JSON-Schema→codec adapters for structured output, *not* API clients. And
there is **no agent-loop, sub-agent, or fan-out abstraction** — the built-in loop
is one model with N tools.

### Verdict for Gauntlet: partially use — and this is a real architectural fork

Gauntlet runs on **Pi**, not on a raw provider API. Two options:

1. **Implement `LanguageModel.make` over Pi**, so Gauntlet's finders/verifiers/
   judge speak `LanguageModel` and model-agnosticism is `Layer` swapping. You
   inherit `Toolkit`, structured output, `Telemetry`, `Tokenizer`, `AiError`
   classification, and — critically — `ExecutionPlan`-based provider fallback.
2. **Keep an `AgentRunner` service of your own shape** and treat `unstable/ai`
   as a source of ideas.

Recommendation: **evaluate (1) seriously but do not commit in this ticket.** The
deciding question is whether Pi's session/tool/event model projects onto
`LanguageModel`'s `ProviderOptions`/`Response.StreamPart` shape without
distortion — Gauntlet's emit-tool-terminates-the-turn protocol and its
pre-validation-argument salvage are unusual, and forcing them through
`generateObject` could lose the salvage path. Regardless of the answer,
**`Tool`/`Toolkit` + `Schema.toJsonSchemaDocument` are worth adopting for the
tool-parameter projection**, and `AiError`'s reason union is a ready-made
taxonomy for the retryable/non-retryable decision in §6. This is a candidate for
its own decision ticket.

---

## 11. Durability — `unstable/workflow`

Real durable execution, in-core: `Workflow.make({ payload, success, error,
idempotencyKey, suspendedRetrySchedule })` with `.execute`/`.poll`/`.interrupt`/
`.resume`; `Activity.make(name, effect, { successSchema, errorSchema,
interruptRetryPolicy })` whose results the engine stores and replays;
`Activity.idempotencyKey`; `Activity.CurrentAttempt`; `Activity.raceAll`;
`DurableClock` (named durable timers); `DurableDeferred` (named wait points
resumable by token); `DurableQueue`; `Workflow.withCompensation`.

`WorkflowEngine.layerMemory` runs **single-process with no cluster**.
`unstable/cluster` is optional and only needed for cross-process durability
(`ClusterWorkflowEngine` persists via `MessageStorage`/SQL). `WorkflowProxy`
derives RPC/HTTP endpoints for execute/resume from a workflow definition.

### Verdict: evaluate, do not adopt reflexively

The vocabulary is an uncanny match for STARTING-POINT.md's `DurableRun`,
"resume reuses valid paid outputs", and "what is the idempotency unit?" —
`Activity` *is* "a paid step whose result is stored and replayed", and
`Activity.idempotencyKey` *is* the idempotency unit made explicit.

But: `layerMemory` is in-memory, so it gives you replay-within-a-process, not
crash durability. Crash durability needs a persistent `WorkflowEngine`, which at
this pin means SQL via the cluster engine — a heavy dependency for a local tool
whose current durability story is "launchd + files committed by rename".

The honest framing for the durability decision ticket: **`Workflow` is worth
adopting only if Gauntlet decides its durability unit is "activity results
persisted and replayed" rather than "artifact files validated on resume."** They
are two coherent designs and mixing them would be worse than either. Note that
the file-based design is *not* a hand-roll of `Workflow` — it is a different
model, and `Schema` + atomic rename is a complete implementation of it.

---

## 12. Things Gauntlet must still hand-roll

Short list, and it is genuinely short:

1. **Atomic file writes** (§3) and any file locking. ~15 and ~20 lines.
2. **Config file loading** — read + parse + `ConfigProvider.fromUnknown` (§2).
   ~20 lines.
3. **The preset table** — a plain record keyed by a `Schema` literal union.
4. **The Pi adapter** — either a `LanguageModel` implementation or an
   `AgentRunner` service (§10).
5. **Agent fan-out orchestration** — Effect gives concurrency, deadlines, and
   failure isolation as primitives; the *policy* (which lenses, what caps, how
   coverage loss is reported) is Gauntlet's domain logic and should stay so.
6. **The deterministic scripted agent adapter** for tests (§8).
7. **Artifact identity/checksums** — Schema validates shape, not provenance.
8. **An MCP client**, if sub-agents are ever addressed over MCP —
   `unstable/ai/McpServer` is server-side only.

---

## 13. beta.90 → beta.106 drift

The pin matters. beta.106 is the current `beta` dist-tag (npm `dist-tags`:
`beta: 4.0.0-beta.106`, `latest: 3.22.1`). Diffed module trees and export lists:

**Stable.** The export map is unchanged (same 20 subpaths). `Config`,
`ConfigProvider`, `Flag`, `Argument`, `unstable/process`,
`unstable/persistence`, `unstable/observability`, `testing` — **zero export
changes**.

**Additions worth having:**

| Change | Impact for Gauntlet |
|---|---|
| **`Command.wizard`** reintroduced | An interactive builder that walks a command's flags/args and prints the resulting invocation. Directly useful as a "help me build a preset invocation" affordance. |
| **`unstable/cli/CliConfig.ts`** (new) | `CliConfig` is a `Context.Reference` letting you customize/replace the built-in global flags (`--help`/`--version`/`--completions`/`--log-level`). |
| **`FileSystem.glob`** | Pattern-based file discovery — relevant for scope/target selection. |
| `LayerRef.ts`, `SchemaError.ts` (new top-level modules); `SchemaUtils.ts` removed | Minor; `SchemaError` is now its own module rather than an internal re-export. |
| `unstable/ai/McpProtocol.ts` | MCP protocol split out of `McpSchema`. |
| `Command.withHidden` → **`Command.unlisted`** | Rename. Trivial but breaking. |
| `FileSystem` `File.fd` → replaced/reshaped | Minor. |

**The one substantial breaking change — `Schedule`:**

```
removed:  andThen, andThenResult, both, bothLeft, bothRight, bothWith,
          collectInputs, collectOutputs, collectWhile, delays, either,
          eitherLeft, eitherRight, eitherWith, elapsed, reduce, take,
          tapInput, tapOutput, unfold, satisfies*Type (4)
added:    concat, concatResult, max, min, upTo
```

The Effect blog's July recap describes this as "limiting APIs were consolidated
into a cleaner surface" with `Schedule.min`/`Schedule.max` for composing by
output, plus `Schedule.cron` moving closer to vixie semantics. Roughly:
`both*` → `min`, `either*` → `max`, `andThen` → `concat`, `take` → `upTo`.

### Pin recommendation

**Start Gauntlet on the newest beta available at implementation time, not
beta.90.** Reasons: Gauntlet is greenfield, so there is no migration cost;
`Command.wizard` + `CliConfig` + `FileSystem.glob` are all directly useful; and
the `Schedule` consolidation is one you'd otherwise have to do later. The cost
is that cloudflare-hub's reference corpus and both house docs are written against
beta.90 — expect `Schedule` snippets to need translation, and treat
`docs/effect-house-style.md` rule 13 (retry bounding) as semantically true but
syntactically stale.

**Pin exactly, no caret** (house rule 1). Caret ranges on betas invite silent
drift, and this diff shows why.

---

## 14. Surprises

Things nobody asked about that change the design.

### 1. `Effect.partition` is the finder fan-out primitive

```ts
Effect.partition(lenses, runLens, { concurrency: 4 })
// => Effect<[failures: Array<E>, successes: Array<A>]>  — never fails
```

"One failed lens cannot reject successful siblings" and "separate diagnostics
from coverage failures" are two protections in STARTING-POINT.md that a
hand-rolled `Promise.allSettled` + partition normally implements. This is one
call, with concurrency, and it returns coverage loss as *data* rather than
swallowing it. `Effect.all(..., { mode: "result" })` is the order-preserving
sibling when you need positional alignment.

### 2. `ExecutionPlan` is a declarative provider-fallback ladder, built for LLMs

```ts
const plan = ExecutionPlan.make(
  { provide: SonnetLayer, attempts: 2, schedule: Schedule.spaced("3 seconds") },
  { provide: OpusLayer,   attempts: 3, schedule: Schedule.spaced("1 second")  },
  { provide: HaikuLayer },
)
effect.pipe(Effect.withExecutionPlan(plan))
```

Each step supplies a different `Context`/`Layer` with its own attempt cap, retry
schedule, and `while` predicate; the runtime walks steps until one succeeds. The
doc example in the source is *literally* LLM-provider fallback using
`unstable/ai`'s `LanguageModel`. Gauntlet's "provider backoff", "one model per
shipped preset", and any future degrade-to-cheaper-model policy are a data
structure here, not control flow. `Stream.withExecutionPlan` exists too.

### 3. `Logger.toFile` — the run journal, for free

A scoped, batched file logger requiring only `FileSystem` + `Scope`, flushing on
scope close. Combined with `Logger.formatJson` and `Effect.annotateLogs`, the
entire "run logging" requirement is a layer in the run's scope. No writer, no
flush discipline, no rotation logic to get wrong. And `Logger.tracerLogger`
emits logs as *span events*, so if tracing is ever enabled the same log calls
land in the trace without duplication.

### 4. `Metric.dump` / `Metric.snapshot` — reports with no backend

`Metric.snapshot: Effect<ReadonlyArray<Snapshot>>` and
`Metric.dump: Effect<string>`. Every metric in STARTING-POINT.md's observability
wishlist (cache hits, termination modes, coverage failures, retry use) can be a
real `Metric` recorded during the run and serialized into the run artifact at
the end — no OTLP collector, no Prometheus, no decision about "which
observability backend is justified for a small local tool." The answer becomes
"none, and you still get the numbers." `Metric.enableRuntimeMetricsLayer` adds
fiber-runtime metrics on top.

### 5. `PartitionedSemaphore` — permits keyed by anything

A semaphore whose permit pool is per-key. "Warm one agent per model group before
fan-out" and per-provider rate limiting both want *independent* concurrency
budgets per model group — that's `PartitionedSemaphore.make<ModelGroup>()`, not
N hand-managed semaphores in a `Map`. `RcMap` is the adjacent find: refcounted
scoped resources torn down at zero refs, which is what a shared warm session per
model group actually is.

### 6. `Flag.fileSchema` / `fileParse` / `fileText` — schema-validated files at parse time

```ts
Flag.fileSchema("plan", ReviewPlanSchema)   // reads AND decodes during CLI parsing
```

`gauntlet run --plan ./plan.json` validates the file as part of argument
parsing, producing a `CliError.InvalidValue` with proper help rendering instead
of a decode failure deep in the handler. Also `Flag.redacted` returns a
`Redacted.Redacted<string>` so a token passed by flag cannot be logged by
accident, and `Flag.keyValuePair` gives `--set k=v` for free.

### 7. `Schema.toJsonSchemaDocument` + `toStandardSchemaV1` — one schema, three consumers

The open question "can one Effect Schema truthfully serve domain, persistence,
and model-facing tool contracts?" has a mechanical answer: `Schema.Struct`
declares it, `Schema.fromJsonString` persists it,
`Schema.toJsonSchemaDocument` emits the draft-2020-12 JSON Schema a model's
tool-parameter slot wants, and `toStandardSchemaV1` hands it to anything
speaking Standard Schema. `JsonSchema.ts` converts between draft-07 /
2020-12 / OpenAPI 3.0 / 3.1 if Pi wants a specific dialect. And
`unstable/schema/VariantSchema` exists for the cases where the shapes genuinely
must diverge — a principled projection rather than a duplicate declaration.

### 8. The subprocess teardown you would have written badly

`@effect/platform-node-shared`'s spawner kills the **process group**, not the
process (`process.kill(-pid, sig)` / `taskkill /T /F`), escalates SIGTERM →
SIGKILL after `forceKillAfter`, does it from an `acquireRelease` finalizer so it
fires on interruption, and surfaces signal-death as a typed `PlatformError`
rather than a `null` exit code. Orphaned grandchildren after an interrupted run
is the classic bug in tools that shell out; it is already handled. Also note
`detached` defaults to **true** on POSIX — that's what makes group-kill work,
and it's worth knowing before you "fix" it.

### 9. `CliOutput.Formatter` is a swappable `Context.Reference`

`Effect.provide(CliOutput.layer(jsonFormatter))` makes the entire CLI — help,
errors, version — render as JSON. A `--json` mode for machine consumers (or for
Gauntlet-invoked-by-another-agent) is a formatter, not a parallel output path
threaded through every command. The source's own doc comment demonstrates
exactly this.

### 10. `TestClock` is already on, and that's the trap

`@effect/vitest` merges `Layer.mergeAll(TestConsole.layer, TestClock.layer())`
into every `it.effect` by default. "Deterministic tests without real sleeps" is
not something to build — it's the default, and the actual risk is the inverse:
the TestClock never auto-advances, so a deadline test that neither forks +
`TestClock.adjust`s nor uses `it.live` **hangs silently**. `TestConsole.logLines`
/ `errorLines` also make CLI output assertable without capturing stdout, and
`effect/testing/FastCheck` is a straight `fast-check` re-export wired into
`it.prop` — property tests over artifact round-trips cost one line.

### 11. `unstable/encoding/Ndjson` and `Sse`

Newline-delimited JSON and Server-Sent Events framing as stream transducers.
If the run journal becomes an append-only event log (an option STARTING-POINT.md
raises against "completion files"), `Ndjson` is the format and the codec, and
`Stream.splitLines` + `Schema.fromJsonString` reads it back with validation.

### 12. `unstable/devtools`

A client/server for the Effect DevTools inspector — live fiber, span, log, and
metric introspection over a socket. For debugging a 12-way agent fan-out with
layered deadlines, being able to *see* the fiber tree during a run is worth
more than it sounds. Development-only; costs nothing when the layer is absent.

---

## 15. Import cheat sheet

```ts
// core — no @effect/* package
import * as Effect      from "effect/Effect"
import * as Layer       from "effect/Layer"
import * as Schema      from "effect/Schema"
import * as Config      from "effect/Config"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Schedule    from "effect/Schedule"
import * as Stream      from "effect/Stream"
import * as Logger      from "effect/Logger"
import * as Metric      from "effect/Metric"
import * as FileSystem  from "effect/FileSystem"
import * as Path        from "effect/Path"
import * as Terminal    from "effect/Terminal"
import * as ExecutionPlan from "effect/ExecutionPlan"
import * as PartitionedSemaphore from "effect/PartitionedSemaphore"
import * as References  from "effect/References"

// unstable subpaths — may move between betas, verify against the pin
import * as Command     from "effect/unstable/cli/Command"
import * as Flag        from "effect/unstable/cli/Flag"
import * as Argument    from "effect/unstable/cli/Argument"
import * as CliOutput   from "effect/unstable/cli/CliOutput"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import * as KeyValueStore from "effect/unstable/persistence/KeyValueStore"
import * as Otlp        from "effect/unstable/observability/Otlp"
import * as LanguageModel from "effect/unstable/ai/LanguageModel"

// testing
import * as TestClock   from "effect/testing/TestClock"
import { it, expect }   from "@effect/vitest"

// the only real external packages
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeRuntime  from "@effect/platform-node/NodeRuntime"
```

`NodeServices.layer` provides `ChildProcessSpawner | Crypto | FileSystem | Path |
Stdio | Terminal` in one layer — which is a superset of `Command.Environment`.
That is the whole platform wiring for a Gauntlet CLI.

---

## 16. Open questions this research did not settle

1. **Does Pi project cleanly onto `LanguageModel`?** (§10) — the single biggest
   architectural fork found. Needs its own ticket.
2. **Durability model: `Workflow`+`Activity`, or `Schema`+atomic-rename
   artifacts?** (§11) — two coherent designs, do not mix.
3. **Which beta to pin?** (§13) — recommendation is "newest at implementation
   time", but that decouples Gauntlet from the hub's beta.90 reference corpus.
4. **Is `KeyValueStore` worth using at all** given its non-atomic FS backend, or
   does Gauntlet want a bespoke artifact store from the start? (§4)
5. **Should the CLI use `Command.wizard`** (beta.106) as a preset-builder
   affordance, or is that scope creep?

## References

- Effect v4 documentation: <https://effect.plants.sh/> — sections
  [`/cli/`](https://effect.plants.sh/cli/),
  [`/schema/`](https://effect.plants.sh/schema/),
  [`/concurrency/`](https://effect.plants.sh/concurrency/),
  [`/configuration/`](https://effect.plants.sh/configuration/),
  [`/scheduling/`](https://effect.plants.sh/scheduling/),
  [`/observability/`](https://effect.plants.sh/observability/),
  [`/testing/`](https://effect.plants.sh/testing/),
  [`/ai/`](https://effect.plants.sh/ai/),
  [`/cluster/`](https://effect.plants.sh/cluster/)
- Source of truth: <https://github.com/Effect-TS/effect/tree/main/packages/effect/src>
  (the `effect-smol` repo is archived; development moved to `Effect-TS/effect`)
- Migration notes: <https://github.com/Effect-TS/effect-smol/blob/main/MIGRATION.md>
- Beta recaps: <https://www.effect.website/blog/releases/effect/40-beta>,
  <https://www.effect.website/blog/effect-v4beta-july-recap>
- House docs: `cloudflare-hub/docs/effect-house-style.md`,
  `cloudflare-hub/docs/effect-v4-patterns.md`
- Local pin read for this research:
  `cloudflare-hub/node_modules/effect@4.0.0-beta.90`;
  drift checked against `effect@4.0.0-beta.106` from npm.
