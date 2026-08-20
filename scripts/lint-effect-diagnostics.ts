// The Effect-diagnostics gate's runMain boundary: effect-tsgo diagnostics
// over the project, output inherited.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { effectDiagnosticsConfigJson } from "./effect-diagnostics-config.ts"

const repoRoot = `${import.meta.dirname}/..`
const effectTsgo = `${repoRoot}/node_modules/.bin/effect-tsgo`
const projects = ["tsconfig.json"]

const program = Effect.gen(function* () {
  const ci = yield* Config.option(Config.string("CI"))
  const format = Option.isNone(ci) ? "pretty" : "github-actions"

  let failed = false
  for (const project of projects) {
    yield* Console.log(`\n[effect-diagnostics] ${project}`)
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(effectTsgo, [
          "diagnostics",
          "--project",
          project,
          "--format",
          format,
          "--lspconfig",
          effectDiagnosticsConfigJson,
        ], { cwd: repoRoot, stdout: "inherit", stderr: "inherit" })
        return yield* handle.exitCode
      }),
    )
    if (exitCode !== 0) failed = true
  }
  process.exitCode = failed ? 1 : 0
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
