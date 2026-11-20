// The compiled live gate's runMain boundary: build the single-file binary,
// then run real reviews through it from a fresh HOME, on cheap Seats:
//
//   1. an OpenAI Recipe (gpt-6-luna:low, three Finders), cold then warm, for
//      the cache hit rate the digest reports;
//   2. a mixed Recipe: Claude Finders (haiku:low) with OpenAI Pool,
//      Verification and Judgment.
//
// Logins are used in place, never copied: when GAUNTLET_LIVE_HOME (default:
// HOME) has a Gauntlet store, the fresh HOME's `.gauntlet/opencode` is a
// symlink to it; without one the store starts empty and OpenAI needs
// OPENAI_API_KEY. `claude` keeps its own login through CLAUDE_CONFIG_DIR. Set
// OPENCODE_CLAUDE_PATH when `claude` on PATH is a shim. A review passes when
// it exits 0 and its dossier.json has no coverage gap and a verdict from
// Verification, which runs on OpenAI in both Recipes. The temp root is
// removed only on success, leaving debris behind for inspection.
//
//   bun run live-gate-compiled [openai|mixed]   (both when omitted)
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"

class LiveGateStepFailed extends Schema.TaggedError<
  LiveGateStepFailed,
  { readonly brand: unique symbol }
>()("LiveGateStepFailed", {
  step: Schema.String,
  reason: Schema.String,
}) {}

const repoRoot = `${import.meta.dirname}/..`

const RECIPES = {
  "live-openai": { default: "openai/gpt-6-luna:low" },
  "live-mixed": { default: "openai/gpt-6-luna:low", finders: "claude-code/haiku:low" },
}

const LENSES = "diff-scan,cleanup,removed-behavior"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

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
      return yield* LiveGateStepFailed.make({ step, reason: `exited ${String(exitCode)}` })
    }
  })

// What the gate reads from a Run's dossier.json.
const DossierFacts = Schema.fromJsonString(Schema.Struct({
  findings: Schema.Array(Schema.Struct({ _tag: Schema.String })),
  rejected: Schema.Struct({ refutedClaims: Schema.Array(Schema.Unknown) }),
  coverageGaps: Schema.Array(Schema.Unknown),
}))

const MODES = ["openai", "mixed"] as const

// One review through the binary. Exit 0 alone admits a fully degraded review
// (failed Finders still produce a Dossier), and an empty Finder stage skips
// every OpenAI Stage; the gate exists to prove live invocations, so it needs
// no coverage gap and at least one verdict on the seeded bug.
const review = (step: string, binary: string, recipe: string, cwd: string, env: Record<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* Console.log(`\n[live-gate-compiled] ${step}`)

    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make(
          binary,
          ["review", "--recipe", recipe, "--lenses", LENSES],
          { cwd, env, extendEnv: true, stderr: "inherit" },
        )

        const [stdout, exitCode] = yield* Effect.all(
          [Stream.decodeText(handle.stdout).pipe(Stream.mkString), handle.exitCode],
          { concurrency: 2 },
        )

        return { stdout, exitCode }
      }),
    )

    yield* Console.log(result.stdout)

    if (result.exitCode !== 0) {
      return yield* LiveGateStepFailed.make({ step, reason: `exited ${String(result.exitCode)}` })
    }

    const dossierMd = /^dossier\.md: (.+)$/m.exec(result.stdout)?.[1]

    if (dossierMd === undefined) {
      return yield* LiveGateStepFailed.make({ step, reason: "the digest named no dossier.md" })
    }

    const text = yield* fs.readFileString(path.join(path.dirname(dossierMd), "dossier.json"))
    const dossier = yield* Schema.decodeEffect(DossierFacts)(text)

    if (dossier.coverageGaps.length > 0) {
      return yield* LiveGateStepFailed.make({ step, reason: `degraded (${String(dossier.coverageGaps.length)} coverage gaps)` })
    }

    const verdicts = Array.filter(dossier.findings, Predicate.isTagged("Confirmed")).length +
      dossier.rejected.refutedClaims.length

    if (verdicts === 0) {
      return yield* LiveGateStepFailed.make({ step, reason: "no confirmed or refuted BugClaim: Verification did not run" })
    }
  })

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const realHome = yield* Config.String("HOME")
  const liveHome = yield* Config.String("GAUNTLET_LIVE_HOME").pipe(Config.withDefault(realHome))
  const claudeConfig = yield* Config.option(Config.String("CLAUDE_CONFIG_DIR"))
  const which = process.argv[2]
  const modes = which === undefined ? MODES : Array.filter(MODES, (mode) => mode === which)

  if (modes.length === 0) {
    return yield* LiveGateStepFailed.make({ step: "read the mode", reason: `unknown mode ${which ?? ""}: use openai or mixed` })
  }

  const store = path.resolve(liveHome, ".gauntlet", "opencode")
  const storePresent = yield* fs.exists(store)

  yield* runStep("build binary", "bun", ["scripts/bundle.ts"], { cwd: repoRoot })
  const binary = path.join(repoRoot, "dist", "gauntlet")

  const root = yield* fs.makeTempDirectory({ prefix: "gauntlet-live-gate-compiled-" })
  const home = path.join(root, "home")
  yield* fs.makeDirectory(path.join(home, ".gauntlet"), { recursive: true })

  if (storePresent) yield* fs.symlink(store, path.join(home, ".gauntlet", "opencode"))

  const env = {
    HOME: home,
    CLAUDE_CONFIG_DIR: Option.getOrElse(claudeConfig, () => path.join(realHome, ".claude")),
  }

  yield* runStep("config init in a fresh HOME", binary, ["config", "init"], { env })
  yield* Effect.forEach(Record.toEntries(RECIPES), ([name, recipe]) =>
    encodeJson(recipe).pipe(
      Effect.flatMap((text) => fs.writeFileString(path.join(home, ".gauntlet", "recipes", `${name}.json`), text)),
    ))

  const repo = path.join(root, "repo")
  yield* fs.makeDirectory(repo)
  const git = (...args: Array<string>) => runStep(`git ${args[0]}`, "git", args, { cwd: repo, env })
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
  yield* fs.writeFileString(path.join(repo, "discount.ts"), source(`  return Math.round(totalCents * (1 - percent / 10))\n`))

  if (modes.includes("openai")) {
    yield* review("OpenAI review, cold cache", binary, "live-openai", repo, env)
    yield* review("OpenAI review, warm cache", binary, "live-openai", repo, env)
  }

  if (modes.includes("mixed")) {
    yield* review("mixed review: Claude Finders, OpenAI Pool, Verification and Judgment", binary, "live-mixed", repo, env)
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
