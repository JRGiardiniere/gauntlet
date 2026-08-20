// The compiled live gate's runMain boundary: build the single-file binary,
// then prove it end to end from a fresh HOME — `config init` seeds against
// the embedded catalog, and one real working-tree review runs the whole
// pipeline through the binary. Pi credentials are the one thing carried over
// from the real HOME; everything else starts empty. The temp root is removed
// only on success, leaving debris behind for inspection when a step fails.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

class LiveGateStepFailed extends Data.TaggedError("LiveGateStepFailed")<{
  readonly step: string
  readonly reason: string
}> {}

const repoRoot = `${import.meta.dirname}/..`

const runStep = (
  step: string,
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly cwd?: string; readonly env?: Record<string, string> } = {},
) =>
  Effect.gen(function* () {
    yield* Console.log(`\n[live-gate-compiled] ${step}`)
    const exitCode = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(command, args, {
          cwd: options.cwd,
          env: options.env,
          extendEnv: true,
          stdout: "inherit",
          stderr: "inherit",
        })
        return yield* handle.exitCode
      }),
    )
    if (exitCode !== 0) {
      return yield* new LiveGateStepFailed({
        step,
        reason: `exited ${String(exitCode)}`,
      })
    }
  })

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const realHome = yield* Config.string("HOME")

  yield* runStep("build binary", "bun", ["scripts/bundle.ts"], { cwd: repoRoot })

  const root = yield* fs.makeTempDirectory({ prefix: "gauntlet-live-gate-compiled-" })
  const home = path.join(root, "home")
  yield* fs.makeDirectory(path.join(home, ".pi", "agent"), { recursive: true })
  yield* Effect.forEach(
    ["auth.json", "models-store.json", "settings.json"],
    (file) =>
      fs.copyFile(
        path.join(realHome, ".pi", "agent", file),
        path.join(home, ".pi", "agent", file),
      ),
  )

  const binary = path.join(repoRoot, "dist", "gauntlet")
  const env = { HOME: home }
  yield* runStep("config init in a fresh HOME", binary, ["config", "init"], { env })

  const repo = path.join(root, "repo")
  yield* fs.makeDirectory(repo)
  const git = (...args: Array<string>) =>
    runStep(`git ${args[0]}`, "git", args, { cwd: repo, env })
  yield* git("init", "--initial-branch=main")
  yield* git("config", "user.email", "live-gate@example.invalid")
  yield* git("config", "user.name", "live gate")
  const source = (body: string) =>
    `export function applyDiscount(totalCents: number, percent: number): number {\n${body}}\n`
  yield* fs.writeFileString(
    path.join(repo, "discount.ts"),
    source(
      `  if (percent < 0 || percent > 100) throw new Error("bad percent")\n  return Math.round(totalCents * (1 - percent / 100))\n`,
    ),
  )
  yield* git("add", ".")
  yield* git("commit", "-m", "base")
  yield* fs.writeFileString(
    path.join(repo, "discount.ts"),
    source(`  return Math.round(totalCents * (1 - percent / 10))\n`),
  )

  // Exit 0 alone admits a fully degraded review (skipped finders still
  // produce a dossier); the gate exists to prove a live invocation, so
  // narrated degradation is a failure here.
  yield* Console.log("\n[live-gate-compiled] one real review through the binary")
  const review = yield* Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make(
        binary,
        ["review", "quick", "--working-tree", "--lenses", "diff-scan"],
        { cwd: repo, env, extendEnv: true },
      )
      const [stdout, stderr, exitCode] = yield* Effect.all(
        [
          Stream.decodeText(handle.stdout).pipe(Stream.mkString),
          Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
      return { stdout, stderr, exitCode }
    }),
  )
  yield* Console.log(review.stdout)
  yield* Console.error(review.stderr)
  const narration = `${review.stdout}${review.stderr}`
  if (review.exitCode !== 0 || narration.includes("coverage gap")) {
    return yield* new LiveGateStepFailed({
      step: "one real review through the binary",
      reason: review.exitCode === 0
        ? "degraded (coverage gap)"
        : `exited ${String(review.exitCode)}`,
    })
  }

  yield* fs.remove(root, { recursive: true, force: true })
  yield* Console.log("\nlive gate (compiled) passed")
})

NodeRuntime.runMain(
  program.pipe(
    Effect.catchTag("LiveGateStepFailed", (failure) =>
      Effect.gen(function* () {
        yield* Console.error(`[live-gate-compiled] ${failure.step}: ${failure.reason}`)
        process.exitCode = 1
      })),
    Effect.provide(NodeServices.layer),
  ),
)
