// The offline compile smoke's runMain boundary: given a compiled gauntlet
// binary, check its cheap commands from a fresh HOME, then compile
// scripts/compile-smoke-entry.ts for the same target and run it. Nothing
// reaches a model or models.dev. Prints the binary's size and timings.
//
//   bun scripts/compile-smoke.ts dist/gauntlet   (GAUNTLET_TARGET as for bundle.ts)
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Clock from "effect/Clock"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"
import { compileBinary } from "./compile.ts"

class SmokeStepFailed extends Schema.TaggedError<
  SmokeStepFailed,
  { readonly brand: unique symbol }
>()("SmokeStepFailed", {
  step: Schema.String,
  reason: Schema.String,
}) {}

const repoRoot = `${import.meta.dirname}/..`
process.chdir(repoRoot)

// Runs a command under the fresh HOME and answers its stdout and wall time.
const run = (step: string, command: string, args: ReadonlyArray<string>, home: string) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis
    const handle = yield* ChildProcess.make(command, args, {
      cwd: home,
      extendEnv: true,
      env: {
        HOME: home,
        XDG_CONFIG_HOME: undefined,
        XDG_DATA_HOME: undefined,
        XDG_STATE_HOME: undefined,
        XDG_CACHE_HOME: undefined,
        OPENAI_API_KEY: undefined,
        // No real `claude` is ever probed.
        OPENCODE_CLAUDE_PATH: "/nonexistent/claude",
      },
    })
    const [stdout, stderr, exitCode] = yield* Effect.all(
      [
        Stream.decodeText(handle.stdout).pipe(Stream.mkString),
        Stream.decodeText(handle.stderr).pipe(Stream.mkString),
        handle.exitCode,
      ],
      { concurrency: 3 },
    )
    const finished = yield* Clock.currentTimeMillis
    const elapsed = finished - started
    if (exitCode !== 0) {
      return yield* SmokeStepFailed.make({ step, reason: `exited ${String(exitCode)}\n${stdout}${stderr}` })
    }
    return { stdout, elapsed }
  }).pipe(Effect.scoped)

const expectOutput = (step: string, stdout: string, expected: string) =>
  stdout.includes(expected)
    ? Effect.void
    : Effect.fail(SmokeStepFailed.make({ step, reason: `expected "${expected}" in:\n${stdout}` }))

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const [binaryArgument = "dist/gauntlet"] = process.argv.slice(2)
  const binary = path.resolve(binaryArgument)
  const targetSetting = yield* Config.option(Config.String("GAUNTLET_TARGET"))
  const target = Option.getOrUndefined(targetSetting)
  const smokeBinary = `${binary}-compile-smoke`
  const catalog = path.resolve("src/host/fixtures/models.json")

  yield* compileBinary({
    entrySource: 'import "./scripts/compile-smoke-entry.ts"\n',
    outfile: smokeBinary,
    target,
    define: {},
  })

  const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-compile-smoke-home-" })
  const version = yield* run("--version", binary, ["--version"], home)
  yield* expectOutput("--version", version.stdout, "gauntlet v")
  // The embedded content catalog: shipped Recipes and Lenses.
  yield* run("config init", binary, ["config", "init"], home)
  const config = yield* run("config", binary, ["config"], home)
  yield* expectOutput("config", config.stdout, "claude-medium")
  yield* expectOutput("config", config.stdout, "diff-scan")

  const smoke = yield* run("Host smoke", smokeBinary, [catalog], home)
  yield* expectOutput("Host smoke", smoke.stdout, "compile smoke ok")
  yield* fs.remove(smokeBinary)

  const { size } = yield* fs.stat(binary)
  yield* Console.log(smoke.stdout.trim())
  yield* Console.log(
    `${path.basename(binary)}: ${(Number(size) / 1_048_576).toFixed(1)} MiB · --version ${String(version.elapsed)} ms (cold) · Host open, grep and emit ${String(smoke.elapsed)} ms`,
  )
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
