import type * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import { renderAvailable } from "../config/recipe-catalog.ts"
import { resolveRunsRoot } from "../config/settings.ts"
import { deliverCompletedRun, DeliveryError } from "../delivery/delivery.ts"
import type { ArtifactWriteError } from "../run/artifact.ts"
import { executeReviewPlan } from "../run/review-executor.ts"
import { loadRun, type LoadedRun } from "../run/run-record.ts"
import {
  submit,
  SubmissionTargetRequest,
  type SubmissionRequest,
} from "../run/submission.ts"
import { loadCallerAddendum } from "../specification/caller-addendum.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import { RunMilestone, RunMilestones } from "../run/run-milestones.ts"
import { gauntletVersion } from "./version.ts"

// The review program: the review and deliver verbs and the rendering of
// their failures as CLI messages and exit codes. main.ts adds the config,
// login and upgrade verbs around it; the Claude Code mod (mod/engine.ts)
// runs exactly this, in process, without them (#134).

// Flag-combination refusals only: once flags are valid, assembly refusals
// are Submission's own tagged error (issue #105).
export class ReviewCommandError extends Data.TaggedError("ReviewCommandError")<{
  readonly reason: string
}> {}

export const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
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

interface ReviewCommandInput {
  readonly recipe: Option.Option<string>
  readonly lenses: Option.Option<string>
  readonly pr: Option.Option<number>
  readonly commits: Option.Option<string>
  readonly workingTree: boolean
  readonly destination: Destination
  readonly spec: Option.Option<string>
  readonly githubSpec: boolean
  readonly relatedFiles: boolean
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
  relatedFiles,
  spec,
  workingTree,
}: ReviewCommandInput) {
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
      relatedFiles,
    },
    destination,
  )
})

export const reviewCommand = Command.make(
  "review",
  {
    recipe: Argument.String("recipe").pipe(
      Argument.optional,
      Argument.withDescription(
        "Named recipe from the catalog; omit to use the configured default-recipe",
      ),
    ),
    pr: Flag.Int("pr").pipe(
      Flag.optional,
      Flag.withDescription("Review that pull request's range"),
    ),
    commits: Flag.String("commits").pipe(
      Flag.optional,
      Flag.withMetavar("<base>[..<head>]"),
      Flag.withDescription(
        "Review merge-base(base, head)..head; head defaults to HEAD. With --working-tree, extend that range to the current uncommitted work",
      ),
    ),
    workingTree: Flag.Boolean("working-tree").pipe(
      Flag.withDefault(false),
      Flag.withDescription("Review the uncommitted changes against HEAD"),
    ),
    destination: Flag.Literals("destination", ["local", "pr"]).pipe(
      Flag.withDefault("local"),
      Flag.withDescription(
        "local writes the run directory and digest; pr also posts dossier.md",
      ),
    ),
    lenses: Flag.String("lenses").pipe(
      Flag.optional,
      Flag.withDescription(
        "Use exactly these comma-separated Lenses instead of Default Lenses",
      ),
    ),
    spec: Flag.String("spec").pipe(
      Flag.optional,
      Flag.withMetavar("<markdown-file>"),
      Flag.withDescription(
        "Caller Addendum: a Markdown requirements file frozen into the plan and shown to interpretive finders, verification, and judgment",
      ),
    ),
    githubSpec: Flag.Boolean("github-spec").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Use only GitHub closing issues as the automatic ReviewSpecification source for this Run",
      ),
    ),
    relatedFiles: Flag.Boolean("related-files").pipe(
      Flag.withDefault(false),
      Flag.withDescription(
        "Also show Finders every touched file whole, plus the unchanged files that import or are imported by one, tests included",
      ),
    ),
  },
  executeReviewCommand,
).pipe(
  Command.withDescription(
    "Review the working tree, a commit range, or a named pull request. Every review names its target — there is no default. Runs for minutes and streams progress to stderr; exit 0 means a review was produced (zero findings included)",
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

export const deliverCommand = Command.make(
  "deliver",
  {
    runId: Argument.String("run-id").pipe(
      Argument.withDescription("Completed run to post"),
    ),
  },
  ({ runId }) => executeDeliverCommand(runId),
).pipe(
  Command.withDescription(
    "Post a completed pull-request run's dossier.md as a PR comment",
  ),
)

const reviewProgram = Command.make("gauntlet").pipe(
  Command.withSubcommands([reviewCommand, deliverCommand]),
  Command.withDescription("Effect-native, Pi-harnessed code-review agent"),
)

const runReviewProgram = Command.runWith(reviewProgram, {
  version: gauntletVersion,
})

// The config verbs add Config's own failure, rendered like any other.
type ReviewProgramFailure =
  | Effect.Error<ReturnType<typeof runReviewProgram>>
  | Config.ConfigError

// The one rendering of a filesystem or process failure that reaches the CLI
// boundary: `<operation> failed on <path>: <reason>`. Node's errno failures
// carry no description, so their code stands in for one.
export const describePlatformError = (
  failure: PlatformError.PlatformError,
): string => {
  const { reason } = failure
  const operation = `${reason.module}.${reason.method}`
  if (reason._tag === "BadArgument") {
    return `${operation} failed: ${reason.description ?? "bad argument"}`
  }
  const code = Predicate.hasProperty(reason.cause, "code") &&
      Predicate.isString(reason.cause.code)
    ? ` (${reason.cause.code})`
    : ""
  const detail = reason.description ?? `${reason._tag}${code}`
  return reason.pathOrDescriptor === undefined
    ? `${operation} failed: ${detail}`
    : `${operation} failed on ${String(reason.pathOrDescriptor)}: ${detail}`
}

export const describeArtifactWrite = (failure: ArtifactWriteError): string =>
  `failed to write ${failure.path}: ${
    PlatformError.isPlatformError(failure.cause)
      ? describePlatformError(failure.cause)
      : String(failure.cause)
  }`

// Exit codes are the CLI contract (ADR 0005): 0 = review produced (zero
// findings included), 1 = could not review. Findings never affect the exit
// code. Every "could not review" is rendered to stderr before the Promise
// boundary erases its type.
export const renderReviewFailures = <R>(
  self: Effect.Effect<number, ReviewProgramFailure, R>,
) =>
  Effect.gen(function* () {
    const report = yield* RunMilestones
    // Renders a review that could not run (or could not be delivered) as its
    // one stderr line, and reports the same text as data for the mod.
    const refuse = (message: string) =>
      progress(message).pipe(
        Effect.andThen(report(RunMilestone.Refused({ message }))),
        Effect.as(1),
      )
    return yield* self.pipe(
      Effect.catchTags({
        // ShowHelp is help control flow, not a failed review: the CLI has
        // already rendered help (and any parse errors). Plain help exits 0;
        // help shown because arguments failed to parse exits 1.
        ShowHelp: (help) =>
          help.errors.length === 0
            ? Effect.succeed(0)
            : report(RunMilestone.Refused({
              message: help.errors.map((error) => error.message).join("; "),
            })).pipe(Effect.as(1)),
        TargetUnresolvable: (unresolvable) =>
          refuse(`could not review — ${unresolvable.reason}`),
        ArtifactWriteError: (failure) =>
          refuse(`could not review — ${describeArtifactWrite(failure)}`),
        ContentLoadError: (failure) =>
          refuse(`could not review — ${failure.reason} (${failure.path})`),
        ReviewCommandError: (failure) =>
          refuse(`could not review — ${failure.reason}`),
        SubmissionError: (failure) =>
          refuse(`could not review — ${failure.reason}`),
        SpecificationLoadError: (failure) =>
          refuse(`could not review — ${failure.reason} (${failure.path})`),
        // A failed post may still have landed (gh can fail after posting, and
        // a posted comment's receipt can fail to save), so a blind retry
        // could post twice.
        DeliveryError: (failure) =>
          refuse(
            failure.operation === "post" && failure.runId !== undefined
              ? `could not deliver — ${failure.reason}; check the PR for the comment before retrying with gauntlet deliver ${failure.runId}`
              : `could not deliver — ${failure.reason}`,
          ),
        // Configuration failures render standalone: their reasons already
        // name the file or recipe at fault, for review and config verbs alike.
        SettingsError: (failure) =>
          refuse(`${failure.reason} (${failure.path})`),
        RecipeCatalogError: (failure) =>
          refuse(`${failure.reason} (${failure.path})`),
        RecipeSelectionError: (failure) =>
          refuse(
            `could not review — ${failure.reason}${renderAvailable(failure.available)}`,
          ),
        RunError: (failure) =>
          refuse(`could not review — ${failure.reason}`),
        PromptAssemblyError: (failure) =>
          refuse(`could not review — ${failure.reason}`),
        InvocationSetupError: (failure) =>
          refuse(
            `could not review — invocation ${failure.operation}: ${failure.reason}`,
          ),
        AdapterContractViolation: (failure) =>
          refuse(`could not review — ${failure.reason}`),
        PlatformError: (failure) =>
          refuse(`could not review — ${describePlatformError(failure)}`),
      }),
      Effect.catch((unreviewable) =>
        refuse(`could not review — ${String(unreviewable)}`),
      ),
    )
  })

// The review program alone, as the mod runs it: argv as `gauntlet` takes it,
// resolving to the exit code.
export const runReviewCli = (argv: ReadonlyArray<string>) =>
  runReviewProgram(argv).pipe(
    Effect.as(0),
    renderReviewFailures,
  )
