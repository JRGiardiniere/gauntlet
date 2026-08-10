import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"
import * as Command from "effect/unstable/cli/Command"
import { Dossier } from "../domain/dossier.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import { targetIdentityOf } from "../domain/review-target.ts"
import { renderDigest } from "../render/digest.ts"
import { renderReport } from "../render/report.ts"
import { writeArtifactJson, writeArtifactText } from "../run/artifact.ts"
import {
  createRunDirectory,
  makeRunId,
  resolveRunsRoot,
} from "../run/run-record.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"

// The directory the review was invoked from — ambient with a real default,
// overridable in tests (which must not chdir).
export const InvocationDirectory = Context.Reference<string>(
  "gauntlet/InvocationDirectory",
  { defaultValue: () => globalThis.process.cwd() },
)

const writeStdout = Effect.fn("gauntlet.cli.write_stdout")(
  function* (text: string) {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(
      Stream.succeed(text),
      stdio.stdout({ endOnDone: false }),
    )
  },
)

// Progress narration goes to stderr only; stdout stays a clean digest
// (ADR 0005).
const progress = Effect.fn("gauntlet.cli.progress")(
  function* (text: string) {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(
      Stream.succeed(`gauntlet: ${text}\n`),
      stdio.stderr({ endOnDone: false }),
    )
  },
)

const executeReview = Effect.fn("gauntlet.cli.execute_review")(function* () {
  const startedAt = yield* DateTime.now
  yield* progress("resolving working-tree review target")
  const directory = yield* InvocationDirectory
  const target = yield* resolveWorkingTreeTarget(directory)

  const runsRoot = yield* resolveRunsRoot()
  const runId = yield* makeRunId()
  const paths = yield* createRunDirectory(runsRoot, runId)
  yield* progress(`run ${runId}`)

  yield* Effect.scoped(
    Effect.gen(function* () {
      const fileLogger = yield* Logger.toFile(Logger.formatLogFmt, paths.runLog)
      yield* Effect.gen(function* () {
        yield* Effect.log(`run ${runId} started`)

        // Freeze the plan at submission: no seats, no lenses yet — the
        // walking skeleton runs zero agent stages (#16). The diff lands
        // here, exactly once.
        const plan = ReviewPlan.make({
          runId,
          createdAt: DateTime.formatIso(startedAt),
          target,
          seats: {},
          lenses: [],
        })
        yield* progress("freezing review plan")
        yield* writeArtifactJson(paths.plan, ReviewPlan, plan)
        yield* Effect.log("plan frozen", { path: paths.plan })

        const dossier = Dossier.make({
          runId,
          target: targetIdentityOf(target),
          bugClaims: [],
          observations: [],
          coverageGaps: [],
        })
        yield* progress("assembling dossier")
        yield* writeArtifactJson(paths.dossier, Dossier, dossier)

        const endedAt = yield* DateTime.now
        const wallTime = DateTime.distance(startedAt, endedAt)
        const report = renderReport(plan, dossier, {
          costUsd: 0,
          invocationCount: 0,
          wallTimeSeconds: Math.round(Duration.toSeconds(wallTime)),
        })
        yield* writeArtifactText(paths.report, report)
        yield* Effect.log("report rendered", { path: paths.report })

        yield* writeStdout(`${renderDigest(plan, dossier, paths)}\n`)
      }).pipe(Effect.provide(Logger.layer([fileLogger])))
    }),
  )
})

const review = Command.make("review", {}, () => executeReview()).pipe(
  Command.withDescription("Review the working tree's uncommitted changes"),
)

const gauntlet = Command.make("gauntlet").pipe(
  Command.withSubcommands([review]),
  Command.withDescription("Effect-native, Pi-harnessed code-review agent"),
)

// Exit codes are the CLI contract (ADR 0005): 0 = review produced (zero
// findings included), 1 = could not review. Findings never affect the exit
// code. Every "could not review" is rendered to stderr before the Promise
// boundary erases its type.
export const runGauntlet = (
  argv: ReadonlyArray<string>,
) =>
  Command.runWith(gauntlet, { version: "0.0.0" })(argv).pipe(
    Effect.as(0),
    Effect.catchTag("TargetUnresolvable", (unresolvable) =>
      progress(`could not review — ${unresolvable.reason}`).pipe(Effect.as(1)),
    ),
    Effect.catch((unreviewable) =>
      progress(`could not review — ${String(unreviewable)}`).pipe(Effect.as(1)),
    ),
  )
