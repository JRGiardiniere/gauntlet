// The house-style gate's runMain boundary: oxlint (twice), the Effect
// diagnostics, the Effect pin check, and the import-cycle check. The checks
// are independent, so they run concurrently with captured output, and each
// report prints as one uninterleaved block in declaration order.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

const repoRoot = `${import.meta.dirname}/..`
const oxlint = `${repoRoot}/node_modules/.bin/oxlint`
const extraLintTargets = process.argv.slice(2)

const program = Effect.gen(function* () {
  const ci = yield* Config.option(Config.string("CI"))
  const oxlintFormat = Option.isNone(ci) ? "default" : "github"

  const checks: ReadonlyArray<{
    readonly name: string
    readonly command: string
    readonly args: ReadonlyArray<string>
  }> = [
    {
      name: "oxlint",
      command: oxlint,
      args: [
        "--config",
        ".oxlintrc.json",
        "--format",
        oxlintFormat,
        "src",
        "scripts",
        ...extraLintTargets,
      ],
    },
    {
      name: "unknown record early warning",
      command: oxlint,
      args: [
        "--config",
        ".oxlintrc.unknown-record.json",
        "--format",
        oxlintFormat,
        "src",
        "scripts",
        ...extraLintTargets,
      ],
    },
    {
      name: "official Effect diagnostics",
      command: process.execPath,
      args: ["scripts/lint-effect-diagnostics.ts"],
    },
    {
      name: "Effect dependency pins",
      command: process.execPath,
      args: ["scripts/check-effect-pin.ts"],
    },
    {
      name: "import cycles",
      command: process.execPath,
      args: ["scripts/check-import-cycles.ts"],
    },
  ]

  const results = yield* Effect.forEach(
    checks,
    (check) =>
      Effect.scoped(
        Effect.gen(function* () {
          const handle = yield* ChildProcess.make(check.command, check.args, {
            cwd: repoRoot,
            stdout: "pipe",
            stderr: "pipe",
          })
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              Stream.decodeText(handle.stdout).pipe(Stream.mkString),
              Stream.decodeText(handle.stderr).pipe(Stream.mkString),
              handle.exitCode,
            ],
            { concurrency: 3 },
          )
          return { check, stdout, stderr, exitCode }
        }),
      ),
    { concurrency: "unbounded" },
  )

  let failed = false
  for (const result of results) {
    yield* Console.log(`\n[house-style] ${result.check.name}`)
    if (result.stdout !== "") yield* Console.log(result.stdout.trimEnd())
    if (result.stderr !== "") yield* Console.error(result.stderr.trimEnd())
    if (result.exitCode !== 0) failed = true
  }
  process.exitCode = failed ? 1 : 0
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
