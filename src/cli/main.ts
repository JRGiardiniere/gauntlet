import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import * as Flag from "effect/unstable/cli/Flag"
import {
  renderAvailable,
  resolveReviewRecipe,
} from "../config/recipe-catalog.ts"
import { resolveRunsRoot } from "../config/settings.ts"
import { loadFinderLenses } from "../content/lens.ts"
import {
  deliverCompletedRun,
  DeliveryError,
  requirePullRequestTarget,
} from "../delivery/delivery.ts"
import { finderSeat, stageSeat } from "../domain/recipe.ts"
import {
  candidateCapForLens,
  FrozenLens,
  ReviewPlan,
} from "../domain/review-plan.ts"
import type {
  ReviewSpecification,
  SpecificationSourceDiagnostic,
} from "../domain/review-specification.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { writeArtifactJson } from "../run/artifact.ts"
import { executeReviewPlan } from "../run/review-executor.ts"
import {
  createRunDirectory,
  loadRun,
  loadRunToResume,
  makeRunId,
  type LoadedRun,
} from "../run/run-record.ts"
import { liveTargetMatchesPlan } from "../run/target-consistency.ts"
import { loadCallerAddendum } from "../specification/caller-addendum.ts"
import { combineReviewSpecifications } from "../specification/combine.ts"
import { loadGitHubSpecification } from "../specification/github-source.ts"
import {
  LinearSpecificationResolution,
  loadLinearSpecification,
} from "../specification/linear-source.ts"
import {
  chompLine,
  describeGitFailure,
  runGit,
} from "../target/git.ts"
import { resolvePullRequestTarget } from "../target/pull-request.ts"
import {
  resolveWorkingTreeTarget,
  TargetUnresolvable,
} from "../target/working-tree.ts"
import { configCommand } from "./config.ts"

// The directory the review was invoked from — ambient with a real default,
// overridable in tests (which must not chdir).
export const InvocationDirectory = Context.Reference<string>(
  "gauntlet/InvocationDirectory",
  { defaultValue: () => globalThis.process.cwd() },
)

export class ReviewCommandError extends Data.TaggedError("ReviewCommandError")<{
  readonly reason: string
}> {}

const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

type Destination = "local" | "pr"

interface FrozenSpecificationState {
  readonly specification: ReviewSpecification | undefined
  readonly diagnostic: SpecificationSourceDiagnostic | undefined
}

const acquireSpecification = Effect.fn(
  "gauntlet.cli.acquire_specification",
)(function* (
  target: ReviewTarget,
  addendum: ReviewSpecification | undefined,
) {
  const branch = yield* runGit(target.repoRoot, ["branch", "--show-current"]).pipe(
    Effect.map(chompLine),
    Effect.mapError((cause) =>
      new TargetUnresolvable({
        reason: describeGitFailure("could not resolve the current branch", cause),
        cause,
      })
    ),
  )
  const linear = yield* loadLinearSpecification(branch)
  if (LinearSpecificationResolution.$is("Resolved")(linear)) {
    return {
      specification: combineReviewSpecifications(
        linear.specification,
        addendum,
      ),
      diagnostic: undefined,
    } satisfies FrozenSpecificationState
  }
  if (LinearSpecificationResolution.$is("Unreachable")(linear)) {
    return {
      specification: combineReviewSpecifications(undefined, addendum),
      diagnostic: linear.diagnostic,
    } satisfies FrozenSpecificationState
  }
  const fetched = ReviewTarget.guards.PullRequest(target)
    ? yield* loadGitHubSpecification(target.repoRoot, target.number)
    : undefined
  return {
    specification: combineReviewSpecifications(fetched, addendum),
    diagnostic: undefined,
  } satisfies FrozenSpecificationState
})

const maybeDeliver = Effect.fn("gauntlet.cli.maybe_deliver")(function* (
  destination: Destination,
  loaded: LoadedRun,
) {
  if (destination !== "pr") return
  const receipt = yield* deliverCompletedRun(loaded)
  yield* progress(`posted ${receipt.url}`)
})

const startReview = Effect.fn("gauntlet.cli.start_review")(function* (
  recipeName: Option.Option<string>,
  selectedLensNames: ReadonlyArray<string> | undefined,
  pr: Option.Option<number>,
  destination: Destination,
  addendum: ReviewSpecification | undefined,
  frozenSpecificationState: FrozenSpecificationState | undefined,
) {
  const startedAt = yield* DateTime.now
  // Recipe selection fails before any Run exists (issue #24): positional
  // recipe, otherwise the configured Default Recipe — nothing else.
  const selected = yield* resolveReviewRecipe(recipeName)
  yield* progress(`using recipe ${selected.name}`)
  const directory = yield* InvocationDirectory
  const target = yield* Option.match(pr, {
    onNone: () => {
      return Effect.gen(function* () {
        yield* progress("resolving working-tree review target")
        return yield* resolveWorkingTreeTarget(directory)
      })
    },
    onSome: (number) => {
      return Effect.gen(function* () {
        yield* progress(`resolving PR #${String(number)} review target`)
        return yield* resolvePullRequestTarget(directory, number)
      })
    },
  })
  // Scope degradation is never silent (spec #16): each warning is narrated
  // as it is discovered, in addition to landing on the plan and report.
  for (const warning of target.warnings) {
    yield* progress(`warning — ${warning}`)
  }

  yield* progress(
    selectedLensNames === undefined
      ? "loading applicable finder lenses"
      : `loading finder lenses ${selectedLensNames.join(", ")}`,
  )
  // `names` is admitted only when a --lenses selection narrows the catalog;
  // omitting it means every shipped and project-local lens loads.
  const lenses = yield* loadFinderLenses(
    selectedLensNames === undefined
      ? { repoRoot: target.repoRoot }
      : { repoRoot: target.repoRoot, names: selectedLensNames },
  )

  const runsRoot = yield* resolveRunsRoot()
  const runId = yield* makeRunId()
  const paths = yield* createRunDirectory(runsRoot, runId)
  // Each lens freezes its final recipe-resolved seat: the recipe maps the
  // lens's finder class to a seat, and later recipe edits never change a
  // resumed run (ADR 0004/0005).
  // optionalKey admits an absent key, never a present undefined one, so the
  // standard-by-omission convention holds in the persisted plan too.
  const frozenLenses = lenses.map((lens) => {
    const frozen = {
      name: lens.name,
      promptText: lens.promptText,
      seat: finderSeat(selected.recipe, lens.finderClass),
      candidateCap: candidateCapForLens(lens.name),
    }
    return lens.finderClass === "interpretive"
      ? FrozenLens.make({ ...frozen, finderClass: lens.finderClass })
      : FrozenLens.make(frozen)
  })

  // A changed-target resume reuses the abandoned plan's frozen specification
  // verbatim (issue #73/#74): never re-fetch GitHub, never re-read --spec.
  const specificationState = frozenSpecificationState ??
    (yield* acquireSpecification(target, addendum))
  if (specificationState.diagnostic !== undefined) {
    yield* progress(`warning — ${specificationState.diagnostic.message}`)
  }

  const planFields = {
    runId,
    target,
    recipeName: selected.name,
    // Finder seats live on each frozen lens (a mixed standard/interpretive run
    // has no single Finder seat); only the downstream stages are stage state.
    seats: {
      pool: stageSeat(selected.recipe, "pool"),
      verification: stageSeat(selected.recipe, "verification"),
      judgment: stageSeat(selected.recipe, "judgment"),
    },
    lenses: frozenLenses,
  }
  const plan = specificationState.specification === undefined
    ? specificationState.diagnostic === undefined
      ? ReviewPlan.make(planFields)
      : ReviewPlan.make({
          ...planFields,
          specificationSourceDiagnostic: specificationState.diagnostic,
        })
    : specificationState.diagnostic === undefined
      ? ReviewPlan.make({
          ...planFields,
          specification: specificationState.specification,
        })
      : ReviewPlan.make({
          ...planFields,
          specification: specificationState.specification,
          specificationSourceDiagnostic: specificationState.diagnostic,
        })
  yield* progress("freezing review plan")
  yield* writeArtifactJson(paths.plan, ReviewPlan, plan)

  yield* executeReviewPlan({
    plan,
    paths,
    startedAt,
  })
  yield* maybeDeliver(destination, { plan, paths })
})

const resumeReview = Effect.fn("gauntlet.cli.resume_review")(function* (
  requestedRunId: Option.Option<string>,
  destination: Destination,
) {
  const runsRoot = yield* resolveRunsRoot()
  const resumable = yield* loadRunToResume(runsRoot, requestedRunId)
  // The destination guard runs before any paid work: a working-tree run has
  // no PR destination whether it replays or falls back to a new review.
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
  // Only unfinished runs need the changed-target check before they resume
  // paid work against the repository.
  const targetUnchanged = yield* liveTargetMatchesPlan(resumable.plan)
  if (!targetUnchanged) {
    yield* progress("resume unavailable, running a new review")
    const pr = ReviewTarget.guards.PullRequest(resumable.plan.target)
      ? Option.some(resumable.plan.target.number)
      : Option.none()
    // The replacement review reuses the abandoned plan's frozen
    // specification verbatim: --resume never re-reads the addendum file.
    yield* startReview(
      Option.fromNullishOr(resumable.plan.recipeName),
      undefined,
      pr,
      destination,
      undefined,
      {
        specification: resumable.plan.specification,
        diagnostic: resumable.plan.specificationSourceDiagnostic,
      },
    ).pipe(
      Effect.provideService(
        InvocationDirectory,
        resumable.plan.target.repoRoot,
      ),
    )
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

const executeReviewCommand = Effect.fn(
  "gauntlet.cli.execute_review_command",
)(function* (
  recipe: Option.Option<string>,
  lenses: Option.Option<string>,
  resume: Option.Option<string>,
  pr: Option.Option<number>,
  destination: Destination,
  spec: Option.Option<string>,
) {
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
    if (Option.isSome(pr)) {
      return yield* new ReviewCommandError({
        reason: "--pr cannot be combined with --resume; the plan is frozen",
      })
    }
    if (Option.isSome(spec)) {
      return yield* new ReviewCommandError({
        reason: "--spec cannot be combined with --resume; the plan is frozen",
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
  if (destination === "pr" && Option.isNone(pr)) {
    return yield* new ReviewCommandError({
      reason: "--destination pr requires --pr",
    })
  }
  // An explicitly named unusable addendum fails here, before any Run exists
  // (issue #73): the caller selected the file, so absence is never quiet.
  const specification = Option.isSome(spec)
    ? yield* loadCallerAddendum(yield* InvocationDirectory, spec.value)
    : undefined
  yield* startReview(
    recipe,
    Option.isNone(lenses)
      ? undefined
      : lenses.value.split(",").map((name) => name.trim()),
    pr,
    destination,
    specification,
    undefined,
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
    destination: Flag.choice("destination", ["local", "pr"]).pipe(
      Flag.withDefault("local"),
      Flag.withDescription(
        "local writes the run directory and digest; pr also posts dossier.md",
      ),
    ),
    lenses: Flag.string("lenses").pipe(
      Flag.optional,
      Flag.withDescription("Run comma-separated named finder lenses"),
    ),
    resume: Flag.string("resume").pipe(
      Flag.optional,
      Flag.withMetavar("[run-id]"),
      Flag.withDescription(
        "Resume unfinished work when the target is unchanged; omit run-id to select the latest incomplete run. A named complete run reports or delivers its existing artifacts without checking the target.",
      ),
    ),
    spec: Flag.string("spec").pipe(
      Flag.optional,
      Flag.withMetavar("<markdown-file>"),
      Flag.withDescription(
        "Caller Addendum: a Markdown requirements file frozen into the plan and shown to interpretive finders, verification, and judgment",
      ),
    ),
  },
  ({ destination, lenses, pr, recipe, resume, spec }) =>
    executeReviewCommand(recipe, lenses, resume, pr, destination, spec),
).pipe(
  Command.withDescription(
    "Review the working tree or a named pull request",
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
