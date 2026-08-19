import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import { renderAvailable } from "../config/recipe-catalog.ts"
import { resolveRunsRoot } from "../config/settings.ts"
import {
  deliverCompletedRun,
  DeliveryError,
  requirePullRequestTarget,
} from "../delivery/delivery.ts"
import { executeReviewPlan } from "../run/review-executor.ts"
import {
  loadRun,
  loadRunToResume,
  type LoadedRun,
} from "../run/run-record.ts"
import {
  submit,
  SubmissionTargetRequest,
  type SubmissionRequest,
} from "../run/submission.ts"
import { loadCallerAddendum } from "../specification/caller-addendum.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import { configCommand } from "./config.ts"

// Flag-combination refusals only: once flags are valid, assembly refusals
// are Submission's own tagged error (issue #105).
export class ReviewCommandError extends Data.TaggedError("ReviewCommandError")<{
  readonly reason: string
}> {}

const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

type Destination = "local" | "pr"

const maybeDeliver = Effect.fn("gauntlet.cli.maybe_deliver")(function* (
  destination: Destination,
  loaded: LoadedRun,
) {
  if (destination !== "pr") return
  const receipt = yield* deliverCompletedRun(loaded)
  yield* progress(`posted ${receipt.url}`)
})

const startReview = Effect.fn("gauntlet.cli.start_review")(function* (
  request: SubmissionRequest,
  destination: Destination,
) {
  const startedAt = yield* DateTime.now
  const loaded = yield* submit(request)
  yield* executeReviewPlan({ ...loaded, startedAt })
  yield* maybeDeliver(destination, loaded)
})

const resumeReview = Effect.fn("gauntlet.cli.resume_review")(function* (
  requestedRunId: Option.Option<string>,
  destination: Destination,
) {
  const runsRoot = yield* resolveRunsRoot()
  const resumable = yield* loadRunToResume(runsRoot, requestedRunId)
  // The destination guard runs before any paid work: a working-tree run has
  // no PR destination.
  if (destination === "pr") {
    yield* requirePullRequestTarget(resumable.plan)
  }
  if (resumable.complete) {
    yield* progress(
      `run ${resumable.plan.runId} is already complete — ${resumable.paths.dossier} · ${resumable.paths.dossierMarkdown}`,
    )
    yield* maybeDeliver(destination, resumable)
    return
  }
  yield* progress(`resuming run ${resumable.plan.runId}`)
  const startedAt = yield* DateTime.now
  yield* executeReviewPlan({
    ...resumable,
    startedAt,
  })
  yield* maybeDeliver(destination, resumable)
})

const LATEST_RESUME_SENTINEL = "@latest"

interface ReviewCommandInput {
  readonly recipe: Option.Option<string>
  readonly lenses: Option.Option<string>
  readonly resume: Option.Option<string>
  readonly pr: Option.Option<number>
  readonly commits: Option.Option<string>
  readonly workingTree: boolean
  readonly destination: Destination
  readonly spec: Option.Option<string>
  readonly githubSpec: boolean
}

const executeReviewCommand = Effect.fn(
  "gauntlet.cli.execute_review_command",
)(function* ({
  commits,
  destination,
  githubSpec,
  lenses,
  pr,
  recipe,
  resume,
  spec,
  workingTree,
}: ReviewCommandInput) {
  if (Option.isSome(resume)) {
    if (Option.isSome(lenses)) {
      return yield* new ReviewCommandError({
        reason: "--lenses cannot be combined with --resume; the plan is frozen",
      })
    }
    if (Option.isSome(recipe)) {
      return yield* new ReviewCommandError({
        reason: "a recipe cannot be combined with --resume; the plan is frozen",
      })
    }
    if (Option.isSome(pr) || Option.isSome(commits) || workingTree) {
      return yield* new ReviewCommandError({
        reason:
          "a target flag cannot be combined with --resume; the plan is frozen",
      })
    }
    if (Option.isSome(spec)) {
      return yield* new ReviewCommandError({
        reason: "--spec cannot be combined with --resume; the plan is frozen",
      })
    }
    if (githubSpec) {
      return yield* new ReviewCommandError({
        reason:
          "--github-spec cannot be combined with --resume; the plan is frozen",
      })
    }
    yield* resumeReview(
      resume.value === LATEST_RESUME_SENTINEL
        ? Option.none()
        : Option.some(resume.value),
      destination,
    )
    return
  }
  // Every review names its target: with three target kinds an implicit
  // default is exactly the guessing ADR 0005 bans.
  if (Option.isSome(pr)) {
    if (Option.isSome(commits) || workingTree) {
      return yield* new ReviewCommandError({
        reason: "--pr cannot be combined with --commits or --working-tree",
      })
    }
  } else if (Option.isNone(commits) && !workingTree) {
    return yield* new ReviewCommandError({
      reason:
        "name a target: --working-tree, --commits <base>[..<head>], or --pr <number>",
    })
  } else if (
    workingTree && Option.isSome(commits) && commits.value.includes("..")
  ) {
    return yield* new ReviewCommandError({
      reason:
        "--commits <base>..<head> cannot be combined with --working-tree; the working tree is the head",
    })
  }
  if (destination === "pr" && Option.isNone(pr)) {
    return yield* new ReviewCommandError({
      reason: "--destination pr requires --pr",
    })
  }
  if (githubSpec && Option.isNone(pr)) {
    return yield* new ReviewCommandError({
      reason: "--github-spec requires --pr",
    })
  }
  // An explicitly named unusable addendum fails here, before any Run exists
  // (issue #73): the caller selected the file, so absence is never quiet.
  const specification = Option.isSome(spec)
    ? yield* loadCallerAddendum(yield* InvocationDirectory, spec.value)
    : undefined
  // The guards above leave only the valid aims, so the bare remainder is
  // `--working-tree` alone: uncommitted changes vs HEAD.
  const target = Option.isSome(pr)
    ? SubmissionTargetRequest.PullRequest({
        number: pr.value,
        githubSpecOnly: githubSpec,
      })
    : Option.isSome(commits)
      ? workingTree
        ? SubmissionTargetRequest.WorkingTree({ base: commits.value })
        : SubmissionTargetRequest.Commits({ range: commits.value })
      : SubmissionTargetRequest.WorkingTree({ base: undefined })
  yield* startReview(
    {
      target,
      recipeName: recipe,
      selectedLensNames: Option.isNone(lenses)
        ? undefined
        : lenses.value.split(",").map((name) => name.trim()),
      addendum: specification,
    },
    destination,
  )
})

const review = Command.make(
  "review",
  {
    recipe: Argument.string("recipe").pipe(
      Argument.optional,
      Argument.withDescription(
        "Named recipe from the catalog; omit to use the configured default-recipe",
      ),
    ),
    pr: Flag.integer("pr").pipe(
      Flag.optional,
      Flag.withDescription("Review that pull request's range"),
    ),
    commits: Flag.string("commits").pipe(
      Flag.optional,
      Flag.withMetavar("<base>[..<head>]"),
      Flag.withDescription(
        "Review merge-base(base, head)..head; head defaults to HEAD. With --working-tree, extend that range to the current uncommitted work",
      ),
    ),
    workingTree: Flag.boolean("working-tree").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Review the uncommitted changes against HEAD"),
    ),
    destination: Flag.choice("destination", ["local", "pr"]).pipe(
      Flag.withDefault("local"),
      Flag.withDescription(
        "local writes the run directory and digest; pr also posts dossier.md",
      ),
    ),
    lenses: Flag.string("lenses").pipe(
      Flag.optional,
      Flag.withDescription(
        "Use exactly these comma-separated Lenses instead of Default Lenses",
      ),
    ),
    resume: Flag.string("resume").pipe(
      Flag.optional,
      Flag.withMetavar("[run-id]"),
      Flag.withDescription(
        "Continue that run from its frozen inputs; omit run-id to select the latest incomplete run. A named complete run reports or delivers its existing artifacts.",
      ),
    ),
    spec: Flag.string("spec").pipe(
      Flag.optional,
      Flag.withMetavar("<markdown-file>"),
      Flag.withDescription(
        "Caller Addendum: a Markdown requirements file frozen into the plan and shown to interpretive finders, verification, and judgment",
      ),
    ),
    githubSpec: Flag.boolean("github-spec").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Use only GitHub closing issues as the automatic ReviewSpecification source for this Run",
      ),
    ),
  },
  executeReviewCommand,
).pipe(
  Command.withDescription(
    "Review the working tree, a commit range, or a named pull request",
  ),
)

const executeDeliverCommand = Effect.fn(
  "gauntlet.cli.execute_deliver_command",
)(function* (runId: string) {
  const runsRoot = yield* resolveRunsRoot()
  const loaded = yield* loadRun(runsRoot, runId).pipe(
    Effect.mapError((cause) =>
      new DeliveryError({
        operation: "load",
        reason: cause.reason,
        runId,
        cause,
      })),
  )
  const receipt = yield* deliverCompletedRun(loaded)
  yield* Console.log(receipt.url)
})

const deliver = Command.make(
  "deliver",
  {
    runId: Argument.string("run-id").pipe(
      Argument.withDescription("Completed run to post"),
    ),
  },
  ({ runId }) => executeDeliverCommand(runId),
).pipe(
  Command.withDescription(
    "Post a completed pull-request run's dossier.md as a PR comment",
  ),
)

const gauntlet = Command.make("gauntlet").pipe(
  Command.withSubcommands([review, deliver, configCommand]),
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
      SubmissionError: (failure) =>
        progress(`could not review — ${failure.reason}`).pipe(Effect.as(1)),
      SpecificationLoadError: (failure) =>
        progress(`could not review — ${failure.reason} (${failure.path})`).pipe(
          Effect.as(1),
        ),
      DeliveryError: (failure) =>
        progress(
          failure.operation === "post" && failure.runId !== undefined
            ? `could not deliver — ${failure.reason}; retry with gauntlet deliver ${failure.runId}`
            : `could not deliver — ${failure.reason}`,
        ).pipe(Effect.as(1)),
      // Configuration failures render standalone: their reasons already name
      // the file or recipe at fault, for review and config verbs alike.
      SettingsError: (failure) =>
        progress(`${failure.reason} (${failure.path})`).pipe(Effect.as(1)),
      RecipeCatalogError: (failure) =>
        progress(`${failure.reason} (${failure.path})`).pipe(Effect.as(1)),
      RecipeSelectionError: (failure) =>
        progress(
          `could not review — ${failure.reason}${renderAvailable(failure.available)}`,
        ).pipe(Effect.as(1)),
      ConfigCommandError: (failure) =>
        progress(`could not configure — ${failure.reason}`).pipe(Effect.as(1)),
      RunError: (failure) =>
        progress(`could not review — ${failure.reason}`).pipe(Effect.as(1)),
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
