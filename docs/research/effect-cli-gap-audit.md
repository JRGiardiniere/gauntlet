# Effect CLI gap audit

- **Date:** 2026-08-10
- **Scope:** Current Gauntlet CLI, configuration, terminal/output, process, and
  executable-boundary code.
- **Baseline:** `effect@4.0.0-beta.106` and
  `@effect/platform-node@4.0.0-beta.106`, both pinned in `package.json` and
  resolved at Effect repository commit
  [`fb75264`](https://github.com/Effect-TS/effect/tree/fb75264aa78a17a12c5e69adb139fccc421acae0).
- **Prior work:** [issue #2](https://github.com/JRGiardiniere/gauntlet/issues/2)
  and `docs/research/effect-batteries.md`.

## Bottom line

Gauntlet is not broadly hand-rolling Effect facilities. It already uses the
native command tree, global CLI flags, `Config`, `ConfigProvider`,
`Logger.toFile`, `ChildProcess`, `NodeServices`, and `NodeRuntime`. Under the
bar that a change must delete code or at least avoid adding machinery, only two
current changes are worth carrying forward:

1. Delete the obsolete `disablePrettyLogger` options from both executable
   boundaries.
2. Consolidate one-shot human output on `effect/Console` and its already-
   installed `TestConsole`, but only as a deletion: remove the Stream/Sink
   wrappers and custom test capture plumbing; do not add an output service.

Everything else below is either already adopted, domain behavior Effect does
not provide, or a migration that would move code rather than simplify it.

## Recommended now

### 1. Delete the ignored `disablePrettyLogger` options

**Verdict: keep. Priority 1.**

`bin/gauntlet.mjs:9-16` and `scripts/live-gate.mjs:9-16` both pass
`{ disablePrettyLogger: true }` to `NodeRuntime.runMain`. At the pinned version,
`runMain` accepts only `disableErrorReporting` and `teardown`
([pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/platform-node/src/NodeRuntime.ts#L39-L101)).
Because these boundaries are unchecked `.mjs`, the unknown option is silently
ignored.

Delete the option object from both calls. Do not replace it with
`disableErrorReporting`: both programs currently catch and render expected
failures before returning a numeric success value, while an unexpected future
failure should still be reportable. This is pure subtraction with no behavior
change.

### 2. Use `Console` / `TestConsole` for one-shot human output

**Verdict: keep, provided the implementation is net-subtractive. Priority 2.**

Gauntlet currently implements single-string writes by building a one-element
`Stream` and running it into a `Stdio` sink in `src/cli/stdio.ts:1-27`. Its CLI
test then recreates stdout/stderr capture with custom `Sink`s, chunk decoding,
and arrays in `src/cli/main.test.ts:60-85`. The live gate imports that CLI
module solely to print lines (`src/harness/live-gate.ts:8,72`).

Effect already provides `Console.log` and `Console.error`
([pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/Console.ts#L401-L405),
[pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/Console.ts#L535-L540)).
Effect CLI itself uses those exact functions for help and parse errors
([pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/unstable/cli/Command.ts#L2670-L2682)),
and `@effect/vitest` already installs `TestConsole.layer` for every `it.effect`
([pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/vitest/src/internal/internal.ts#L42-L44),
[pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/vitest/src/internal/internal.ts#L353-L357)).
`TestConsole.logLines` and `errorLines` expose the captured channels directly
([pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/testing/TestConsole.ts#L298-L369)).

The simplifying shape is:

- emit the completed digest with one `Console.log` call;
- keep a tiny `progress(text)` helper around `Console.error` only if the
  `gauntlet:` prefix still benefits call sites;
- let the live gate call `Console.log` directly;
- assert through `TestConsole` and delete `CapturedOutput`, `decodeChunk`, and
  the custom stdout/stderr sinks.

This preserves stdout for product output and stderr for progress. The trade-off
is deliberate: `Console.log/error` have no typed `PlatformError` channel,
whereas the raw `Stdio` sinks do. If byte-exact stream failure handling (for
example, a product requirement around broken pipes) is later required, keep
`Stdio`; do not build a second abstraction on top of `Console`. For the current
single-string CLI contract, the native Console path is materially smaller.

## Already adopted; no change

| Capability | Current evidence | Effect source | Verdict |
|---|---|---|---|
| Command tree and parser | `src/cli/main.ts:91-107` uses `Command.make`, `withSubcommands`, and `runWith`. | [`Command`](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/unstable/cli/Command.ts) | Keep. |
| Help, version, wizard, completions, log level | They are automatically installed by the current `runWith`; local `--help`, `--version`, and `--completions zsh` checks passed. | [`GlobalFlag.BuiltIns`](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/unstable/cli/GlobalFlag.ts#L298-L304) | Already free; add no parallel commands. |
| Environment config | `src/run/run-record.ts:33-40` reads `HOME` through `Config`; `src/cli/main.test.ts:68-85` supplies `ConfigProvider.fromUnknown`. | [`ConfigProvider`](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/ConfigProvider.ts) | Keep. No manual precedence merger exists. |
| Run log | `src/cli/main.ts:44-86` uses scoped `Logger.toFile` and a logger layer. | [`Logger.toFile`](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/Logger.ts#L1180-L1300) | Keep. JSON formatting or more annotations would add behavior, not simplify code. |
| Git subprocess | `src/target/git.ts:33-67` uses `ChildProcess`, structured scope, and concurrent stream draining. | [`ChildProcessSpawner`](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/unstable/process/ChildProcessSpawner.ts) | Keep. The convenience `string` helper does not validate exit status or preserve separate stderr. |
| Node platform/runtime | Both executable edges provide `NodeServices.layer` and cross through `NodeRuntime.runMain` once. | [`NodeServices`](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/platform-node/src/NodeServices.ts) | Keep after deleting the ignored option. |

## Tempting, but skip

### `CliOutput.Formatter` for machine output

**Skip.** The earlier battery inventory overstates this as a general
machine-output switch. At beta.106, `Formatter` covers help documents, CLI
errors, grouped errors, and version strings only
([pinned interface](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/unstable/cli/CliOutput.ts#L1-L8),
[pinned interface](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/unstable/cli/CliOutput.ts#L52-L199)).
It cannot format Gauntlet's digest, progress narration, report, or dossier.
ADR 0005 already gives machine consumers the schema-decoded `dossier.json`, so
a JSON CLI formatter would create a second output path without solving a need.

### Replace `runWith(argv)` with `Command.run`

**Skip.** `Command.run` reads arguments from `Stdio.args`
([pinned source](https://github.com/Effect-TS/effect/blob/fb75264aa78a17a12c5e69adb139fccc421acae0/packages/effect/src/unstable/cli/Command.ts#L2866-L2877)).
That would remove `process.argv.slice(2)` at the executable edge but require
tests to inject the same array through `Stdio.layerTest`. The explicit
`runGauntlet(argv)` function is a small, useful programmatic/test boundary;
switching only relocates the plumbing.

### Delegate exit codes to `Runtime.errorExitCode`

**Skip.** `CliError.ShowHelp` does carry the correct runtime exit-code marker,
but Gauntlet also renders domain failures and exposes a numeric result to tests
in `src/cli/main.ts:100-123`. Letting failures escape would require reported-
error markers, a wrapper error, a custom teardown, or globally disabling
unexpected-error reporting. The current explicit mapping is shorter and more
honest.

### Turn the live gate into an Effect command

**Skip for now.** `src/harness/live-gate.ts:115-118` has exactly two positional
values with two defaults. `Argument.string` / `withDefault` are available, but
the command declaration and runner would be larger than the two lines they
replace. Move it into the real command tree only if it gains validation or a
public option surface.

### Add Terminal, Prompt, wizard, or custom `CliConfig`

**Skip.** The public flow is deliberately non-interactive. `--wizard` is
already part of the pinned built-ins; `Terminal` and `Prompt` would add a second
interaction mode. Customizing the built-ins through `CliConfig` is also extra
wiring unless the public CLI explicitly decides to remove one.

### Build config precedence before settings exist

**Skip now; use the native pieces when there is a real conflict to resolve.**
`Flag.withFallbackConfig`, `Argument.withFallbackConfig`, and
`ConfigProvider.layerAdd` are available. Current code has only `HOME`, and ADR
0005 has already collapsed future recipe precedence to named recipe over one
settings value. In particular, do not use the earlier research's static
`Argument.choice` preset idea: recipes are filesystem content, so adding one
must not require a code change. When `settings.json` lands, read and decode it
once; use native fallback combinators only where they delete an actual merge.

### Convert maintenance scripts to Effect

**Skip.** The direct `process.env`, `console`, and synchronous child-process
calls under `scripts/` are short build/lint orchestration boundaries. Giving
each one `NodeServices`, a runtime, layers, and typed error rendering would
increase code without improving the product CLI.

## Maturity and drift

- `Console` and `TestConsole` are stable top-level/testing APIs, so the output
  consolidation has relatively low drift risk.
- `effect/unstable/cli` and `effect/unstable/process` are both unstable, and the
  dependency is still a beta. Keep the exact pin and verify the installed
  source before adopting another convenience API.
- The ignored `disablePrettyLogger` option is concrete evidence of that drift.
  Deleting stale options is safer than replacing them speculatively.
- At this pin `Command.withHidden` from the older inventory is now
  `Command.unlisted`; avoid copying beta.90-era snippets blindly.

## Priority order

1. Remove both ignored `disablePrettyLogger` option objects.
2. If desired as one contained cleanup, move one-shot user output to
   `Console`/`TestConsole` and delete the Stdio capture layer; do not introduce
   a replacement abstraction.
3. Make no other Effect-driven CLI/config refactor until the corresponding ADR
   feature actually lands.
