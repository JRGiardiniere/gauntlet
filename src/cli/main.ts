import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { DEFAULT_CANDIDATE_CAP } from "../content/finder-prompt.ts"
import {
  ContentLoadError,
  loadFinderLens,
} from "../content/lens.ts"
import { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { writeArtifactJson } from "../run/artifact.ts"
import { executeReviewPlan } from "../run/review-executor.ts"
import {
  createRunDirectory,
  loadRunToResume,
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

export class ReviewCommandError extends Data.TaggedError("ReviewCommandError")<{
  readonly reason: string
}> {}

// Issue #24 owns recipes and configurable seats. This slice uses the same
// near-zero-cost seat as the live gate so `review --lenses <one>` is real
// without pre-implementing the recipe surface.
export const TRACER_FINDER_PROVIDER = "openai-codex"
export const TRACER_FINDER_MODEL = "gpt-5.6-luna:low"
export const TRACER_FINDER_SEAT =
  `${TRACER_FINDER_PROVIDER}/${TRACER_FINDER_MODEL}`

const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

const startReview = Effect.fn("gauntlet.cli.start_review")(function* (
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
  const lens = yield* loadFinderLens(lensName)
  if (lens.needsSpec) {
    return yield* new ContentLoadError({
      path: lens.name,
      reason: "selected lens needs spec text; spec-aware planning lands in issue #21",
    })
  }

  const runsRoot = yield* resolveRunsRoot()
  const runId = yield* makeRunId()
  const paths = yield* createRunDirectory(runsRoot, runId)
  const frozenLens = FrozenLens.make({
    name: lens.name,
    promptText: lens.promptText,
    contentHash: lens.contentHash,
    ...(lens.category === undefined
      ? {}
      : { category: lens.category }),
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

  yield* executeReviewPlan({
    plan,
    paths,
    startedAt,
  })
})

const resumeReview = Effect.fn("gauntlet.cli.resume_review")(function* (
  requestedRunId: Option.Option<string>,
) {
  const runsRoot = yield* resolveRunsRoot()
  const resumable = yield* loadRunToResume(runsRoot, requestedRunId)
  yield* progress(`resuming run ${resumable.plan.runId}`)
  const startedAt = yield* DateTime.now
  yield* executeReviewPlan({
    ...resumable,
    startedAt,
  })
})

const LATEST_RESUME_SENTINEL = "@latest"

const executeReviewCommand = Effect.fn(
  "gauntlet.cli.execute_review_command",
)(function* (
  lenses: Option.Option<string>,
  resume: Option.Option<string>,
) {
  if (Option.isSome(resume)) {
    if (Option.isSome(lenses)) {
      return yield* new ReviewCommandError({
        reason: "--lenses cannot be combined with --resume; the plan is frozen",
      })
    }
    yield* resumeReview(
      resume.value === LATEST_RESUME_SENTINEL
        ? Option.none()
        : Option.some(resume.value),
    )
    return
  }
  if (Option.isNone(lenses)) {
    return yield* new ReviewCommandError({
      reason: "--lenses is required when starting a review",
    })
  }
  yield* startReview(lenses.value)
})

const review = Command.make(
  "review",
  {
    lenses: Flag.string("lenses").pipe(
      Flag.optional,
      Flag.withDescription("Run one named finder lens"),
    ),
    resume: Flag.string("resume").pipe(
      Flag.optional,
      Flag.withMetavar("[run-id]"),
      Flag.withDescription(
        "Resume a run; omit run-id to select the latest incomplete run",
      ),
    ),
  },
  ({ lenses, resume }) => executeReviewCommand(lenses, resume),
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
  Command.runWith(gauntlet, { version: "0.0.0" })(
    // Effect CLI models optional flags and valued flags, but not a flag with
    // an optional value. Normalize only the documented bare --resume form;
    // --resume <run-id> and --resume=<run-id> remain native parser input.
    argv.map((argument, index) =>
      argument === "--resume" &&
          (argv[index + 1] === undefined || argv[index + 1]?.startsWith("-"))
        ? `--resume=${LATEST_RESUME_SENTINEL}`
        : argument),
  ).pipe(
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
      ReviewCommandError: (failure) =>
        progress(`could not review — ${failure.reason}`).pipe(Effect.as(1)),
      RunResumeError: (failure) =>
        progress(`could not review — ${failure.reason}`).pipe(Effect.as(1)),
      InvocationJournalReadError: (failure) =>
        progress(`could not review — failed to read ${failure.path}`).pipe(
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
