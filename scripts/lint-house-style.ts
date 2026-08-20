// The house-style gate's runMain boundary: oxlint (twice), the Effect
// diagnostics, the Effect pin check, and the import-cycle check, each spawned
// with inherited output so their reports land on the terminal unchanged.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
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

  let failed = false
  for (const check of checks) {
    yield* Console.log(`\n[house-style] ${check.name}`)
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(check.command, check.args, {
          cwd: repoRoot,
          stdout: "inherit",
          stderr: "inherit",
        })
        return yield* handle.exitCode
      }),
    )
    if (exitCode !== 0) failed = true
  }
  process.exitCode = failed ? 1 : 0
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
