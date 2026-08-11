import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { assembleSingleLensDossier } from "../assembly/single-lens.ts"
import {
  assembleFinderPrompt,
  DEFAULT_CANDIDATE_CAP,
  FINDER_TOOLS,
} from "../content/finder-prompt.ts"
import {
  ContentLoadError,
  loadFinderContent,
} from "../content/lens.ts"
import { Dossier } from "../domain/dossier.ts"
import { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { targetIdentityOf } from "../domain/review-target.ts"
import { invoke } from "../harness/invoke.ts"
import { EmitFindings } from "../harness/output-contract.ts"
import { renderDigest } from "../render/digest.ts"
import { renderReport } from "../render/report.ts"
import { writeArtifactJson, writeArtifactText } from "../run/artifact.ts"
import { writeFinderInvocation } from "../run/invocation-journal.ts"
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

// Issue #24 owns recipes and configurable seats. This slice uses the same
// near-zero-cost seat as the live gate so `review --lenses <one>` is real
// without pre-implementing the recipe surface.
export const TRACER_FINDER_PROVIDER = "openai-codex"
export const TRACER_FINDER_MODEL = "gpt-5.6-luna:low"
export const TRACER_FINDER_SEAT =
  `${TRACER_FINDER_PROVIDER}/${TRACER_FINDER_MODEL}`

const TRACER_DEADLINES = {
  overallMillis: 600_000,
  startupMillis: 60_000,
  firstResponseMillis: 300_000,
  toolMillis: 120_000,
  bashMillis: 600_000,
} as const

const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

const executeReview = Effect.fn("gauntlet.cli.execute_review")(function* (
  lensName: string,
) {
  const startedAt = yield* DateTime.now
  yield* progress("resolving working-tree review target")
  const directory = yield* InvocationDirectory
  const target = yield* resolveWorkingTreeTarget(directory)
  // Scope degradation is never silent (spec #16): each warning is narrated
  // as it is discovered, in addition to landing on the plan and report.
  for (const warning of target.warnings) {
    yield* progress(`warning — ${warning}`)
  }

  yield* progress(`loading lens ${lensName}`)
  const content = yield* loadFinderContent(lensName)
  if (content.lens.needsSpec) {
    return yield* new ContentLoadError({
      path: content.lens.name,
      reason: "selected lens needs spec text; spec-aware planning lands in issue #21",
    })
  }

  const runsRoot = yield* resolveRunsRoot()
  const runId = yield* makeRunId()
  const paths = yield* createRunDirectory(runsRoot, runId)
  yield* progress(`run ${runId}`)

  yield* Effect.scoped(
    Effect.gen(function* () {
      const fileLogger = yield* Logger.toFile(Logger.formatLogFmt, paths.runLog)
      yield* Effect.gen(function* () {
        yield* Effect.log(`run ${runId} started`)

        const frozenLens = FrozenLens.make({
          name: content.lens.name,
          promptText: content.lens.promptText,
          contentHash: content.lens.contentHash,
          ...(content.lens.category === undefined
            ? {}
            : { category: content.lens.category }),
          candidateCap: DEFAULT_CANDIDATE_CAP,
        })

        // The lens tail and its derived identity are frozen before the paid
        // invocation. The invocation reads only this FrozenLens afterward.
        const plan = ReviewPlan.make({
          runId,
          createdAt: DateTime.formatIso(startedAt),
          target,
          seats: { finders: TRACER_FINDER_SEAT },
          lenses: [frozenLens],
        })
        yield* progress("freezing review plan")
        yield* writeArtifactJson(paths.plan, ReviewPlan, plan)
        yield* Effect.log("plan frozen", { path: paths.plan })

        const prompt = yield* assembleFinderPrompt(
          content.sharedPromptTemplate,
          target,
          frozenLens,
        )
        yield* progress(`invoking finder ${frozenLens.name}`)
        const outcome = yield* invoke({
          cwd: target.repoRoot,
          systemPrompt: content.systemPrompt,
          prompt,
          sessionId: `${runId}-finders`,
          contract: EmitFindings,
          tools: FINDER_TOOLS,
          deadlines: TRACER_DEADLINES,
        })
        const invocationKey = `finder-${frozenLens.name}`
        yield* writeFinderInvocation(paths.journalDirectory, {
          runId,
          invocationKey,
          lens: frozenLens.name,
          outcome,
        })
        yield* Effect.log("finder invocation journaled", { invocationKey })

        const dossier = assembleSingleLensDossier(
          runId,
          targetIdentityOf(target),
          frozenLens,
          outcome.output,
        )
        yield* progress("assembling dossier")
        yield* writeArtifactJson(paths.dossier, Dossier, dossier)

        const endedAt = yield* DateTime.now
        const wallTime = DateTime.distance(startedAt, endedAt)
        const accounting = {
          costUsd: outcome.usage.costUsd,
          invocationCount: 1,
          wallTimeSeconds: Math.round(Duration.toSeconds(wallTime)),
        }
        const report = renderReport(plan, dossier, accounting)
        yield* writeArtifactText(paths.report, report)
        yield* Effect.log("report rendered", { path: paths.report })

        yield* Console.log(renderDigest(plan, dossier, accounting, paths))
      }).pipe(Effect.provide(Logger.layer([fileLogger])))
    }),
  )
})

const review = Command.make(
  "review",
  {
    lenses: Flag.string("lenses").pipe(
      Flag.withDescription("Run one named finder lens"),
    ),
  },
  ({ lenses }) => executeReview(lenses),
).pipe(
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
    Effect.catchTags({
      // ShowHelp is help control flow, not a failed review: the CLI has
      // already rendered help (and any parse errors). Plain help exits 0;
      // help shown because arguments failed to parse exits 1.
      ShowHelp: (help) => Effect.succeed(help.errors.length === 0 ? 0 : 1),
      TargetUnresolvable: (unresolvable) =>
        progress(`could not review — ${unresolvable.reason}`).pipe(Effect.as(1)),
      ArtifactWriteError: (failure) =>
        progress(`could not review — failed to write ${failure.path}`).pipe(
          Effect.as(1),
        ),
      ContentLoadError: (failure) =>
        progress(`could not review — ${failure.reason} (${failure.path})`).pipe(
          Effect.as(1),
        ),
      PromptAssemblyError: (failure) =>
        progress(`could not review — ${failure.reason}`).pipe(Effect.as(1)),
      InvocationSetupError: (failure) =>
        progress(
          `could not review — invocation ${failure.operation}: ${failure.reason}`,
        ).pipe(Effect.as(1)),
      AdapterContractViolation: (failure) =>
        progress(`could not review — ${failure.reason}`).pipe(Effect.as(1)),
    }),
    Effect.catch((unreviewable) =>
      progress(`could not review — ${String(unreviewable)}`).pipe(Effect.as(1)),
    ),
  )
