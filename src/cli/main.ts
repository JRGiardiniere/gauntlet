import * as Console from "effect/Console"
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
import { loadSettings, resolveRunsRoot } from "../config/settings.ts"
import { loadFinderLenses } from "../content/lens.ts"
import {
  deliverCompletedRun,
  DeliveryError,
  requirePullRequestTarget,
} from "../delivery/delivery.ts"
import { finderSeat, stageSeat } from "../domain/recipe.ts"
import { resolveLensNames } from "../domain/lens-selection.ts"
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
import { writeArtifactBytes, writeArtifactJson } from "../run/artifact.ts"
import { executeReviewPlan } from "../run/review-executor.ts"
import { captureWorkspaceOverlay } from "../run/review-working-directory.ts"
import {
  createRunDirectory,
  loadRun,
  loadRunToResume,
  makeRunId,
  type LoadedRun,
} from "../run/run-record.ts"
import { loadCallerAddendum } from "../specification/caller-addendum.ts"
import { combineReviewSpecifications } from "../specification/combine.ts"
import { loadGitHubSpecification } from "../specification/github-source.ts"
import {
  LinearSpecificationResolution,
  loadLinearSpecification,
} from "../specification/linear-source.ts"
import { resolveCommitsTarget } from "../target/commits.ts"
import {
  chompLine,
  describeGitFailure,
  runGit,
  TargetUnresolvable,
} from "../target/git.ts"
import { resolvePullRequestTarget } from "../target/pull-request.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
import { configCommand } from "./config.ts"
import { InvocationDirectory } from "./invocation-directory.ts"

export { InvocationDirectory } from "./invocation-directory.ts"

export class ReviewCommandError extends Data.TaggedError("ReviewCommandError")<{
  readonly reason: string
}> {}

const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

type Destination = "local" | "pr"

interface AcquiredSpecification {
  readonly specification: ReviewSpecification | undefined
  readonly diagnostic: SpecificationSourceDiagnostic | undefined
}

interface StartReviewRequest {
  readonly recipeName: Option.Option<string>
  readonly selectedLensNames: ReadonlyArray<string> | undefined
  readonly pr: Option.Option<number>
  readonly commits: Option.Option<string>
  readonly workingTree: boolean
  readonly destination: Destination
  readonly addendum: ReviewSpecification | undefined
  readonly githubSpec: boolean
}

// The caller aims explicitly (ADR 0005). `--commits` with `--working-tree` is
// one target: the committed range extended to the working tree as submitted.
const resolveTarget = Effect.fn("gauntlet.cli.resolve_target")(function* ({
  commits,
  pr,
  workingTree,
}: Pick<StartReviewRequest, "commits" | "pr" | "workingTree">) {
  const directory = yield* InvocationDirectory
  if (Option.isSome(pr)) {
    yield* progress(`resolving PR #${String(pr.value)} review target`)
    return yield* resolvePullRequestTarget(directory, pr.value)
  }
  if (Option.isSome(commits)) {
    if (!workingTree) {
      yield* progress(`resolving ${commits.value} review target`)
      return yield* resolveCommitsTarget(directory, commits.value)
    }
    yield* progress(
      `resolving ${commits.value} plus working-tree review target`,
    )
    return yield* resolveWorkingTreeTarget(directory, commits.value)
  }
  // Target selection is validated before this point, so the remaining form is
  // `--working-tree` alone: uncommitted changes vs HEAD.
  yield* progress("resolving working-tree review target")
  return yield* resolveWorkingTreeTarget(directory, undefined)
})

const resolveSpecificationBranch = Effect.fn(
  "gauntlet.cli.resolve_specification_branch",
)(function* (repoRoot: string) {
  return yield* runGit(repoRoot, ["branch", "--show-current"]).pipe(
    Effect.map(chompLine),
    Effect.mapError((cause) =>
      new TargetUnresolvable({
        reason: describeGitFailure("could not resolve the current branch", cause),
        cause,
      })
    ),
  )
})

const acquireSpecification = Effect.fn(
  "gauntlet.cli.acquire_specification",
)(function* (
  target: ReviewTarget,
  addendum: ReviewSpecification | undefined,
  githubSpec: boolean,
) {
  const branch = yield* resolveSpecificationBranch(target.repoRoot)
  const linear = githubSpec ? undefined : yield* loadLinearSpecification(branch)
  if (
    linear !== undefined &&
    LinearSpecificationResolution.$is("Resolved")(linear)
  ) {
    return {
      specification: combineReviewSpecifications(
        linear.specification,
        addendum,
      ),
      diagnostic: undefined,
    } satisfies AcquiredSpecification
  }
  const diagnostic = linear !== undefined &&
      LinearSpecificationResolution.$is("Unreachable")(linear)
    ? linear.diagnostic
    : undefined
  const fetched = ReviewTarget.guards.PullRequest(target)
    ? yield* loadGitHubSpecification(target.repoRoot, target.number)
    : undefined
  if (githubSpec && fetched === undefined) {
    return yield* new ReviewCommandError({
      reason:
        "--github-spec could not resolve a ReviewSpecification from GitHub closing issues",
    })
  }
  return {
    specification: combineReviewSpecifications(fetched, addendum),
    diagnostic,
  } satisfies AcquiredSpecification
})

const maybeDeliver = Effect.fn("gauntlet.cli.maybe_deliver")(function* (
  destination: Destination,
  loaded: LoadedRun,
) {
  if (destination !== "pr") return
  const receipt = yield* deliverCompletedRun(loaded)
  yield* progress(`posted ${receipt.url}`)
})

const startReview = Effect.fn("gauntlet.cli.start_review")(function* ({
  addendum,
  commits,
  destination,
  githubSpec,
  pr,
  recipeName,
  selectedLensNames,
  workingTree,
}: StartReviewRequest) {
  const startedAt = yield* DateTime.now
  // Recipe selection fails before any Run exists (issue #24): positional
  // recipe, otherwise the configured Default Recipe — nothing else.
  const selected = yield* resolveReviewRecipe(recipeName)
  yield* progress(`using recipe ${selected.name}`)
  const defaultLensNames = selectedLensNames === undefined
    ? yield* Effect.gen(function* () {
        const settings = yield* loadSettings()
        if (Option.isNone(settings)) {
          return yield* new ReviewCommandError({
            reason:
              "no Default Lenses are configured — pass --lenses or run `gauntlet config init`",
          })
        }
        return settings.value["default-lenses"]
      })
    : []
  const target = yield* resolveTarget({ commits, pr, workingTree })
  // Scope degradation is never silent (spec #16): each warning is narrated
  // as it is discovered, in addition to landing on the plan and report.
  for (const warning of target.warnings) {
    yield* progress(`warning — ${warning}`)
  }
  // Uncommitted state is the one input Git cannot reconstruct from the frozen
  // head commit, so it is captured while the resolved target is still current.
  const overlay = ReviewTarget.guards.WorkingTree(target)
    ? yield* Effect.scoped(captureWorkspaceOverlay(target))
    : undefined

  const resolvedLensNames = resolveLensNames(
    selectedLensNames,
    defaultLensNames,
  )
  yield* progress(
    selectedLensNames === undefined
      ? `loading Default Lenses ${resolvedLensNames.join(", ") || "(none)"}`
      : `loading exact caller Lenses ${resolvedLensNames.join(", ") || "(none)"}`,
  )
  const lenses = yield* loadFinderLenses({
    repoRoot: target.repoRoot,
    names: resolvedLensNames,
  })

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

  const specificationState = yield* acquireSpecification(
    target,
    addendum,
    githubSpec,
  )
  if (specificationState.diagnostic !== undefined) {
    yield* progress(`warning — ${specificationState.diagnostic.message}`)
  }

  const runsRoot = yield* resolveRunsRoot()
  const runId = yield* makeRunId()
  const paths = yield* createRunDirectory(runsRoot, runId)
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
  // Overlay first: a persisted plan implies its overlay exists.
  if (overlay !== undefined) {
    yield* writeArtifactBytes(paths.workspaceOverlay, overlay)
  }
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
  yield* startReview({
    recipeName: recipe,
    selectedLensNames: Option.isNone(lenses)
      ? undefined
      : lenses.value.split(",").map((name) => name.trim()),
    pr,
    commits,
    workingTree,
    destination,
    addendum: specification,
    githubSpec,
  })
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
