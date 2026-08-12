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
import { finderSeat, stageSeat } from "../domain/recipe.ts"
import {
  candidateCapForLens,
  FrozenLens,
  ReviewPlan,
} from "../domain/review-plan.ts"
import { writeArtifactJson } from "../run/artifact.ts"
import { executeReviewPlan } from "../run/review-executor.ts"
import {
  createRunDirectory,
  loadRunToResume,
  makeRunId,
} from "../run/run-record.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
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

const startReview = Effect.fn("gauntlet.cli.start_review")(function* (
  recipeName: Option.Option<string>,
  selectedLensNames: ReadonlyArray<string> | undefined,
) {
  const startedAt = yield* DateTime.now
  // Recipe selection fails before any Run exists (issue #24): positional
  // recipe, otherwise the configured Default Recipe — nothing else.
  const selected = yield* resolveReviewRecipe(recipeName)
  yield* progress(`using recipe ${selected.name}`)
  yield* progress("resolving working-tree review target")
  const directory = yield* InvocationDirectory
  const target = yield* resolveWorkingTreeTarget(directory)
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
  const lenses = yield* loadFinderLenses({
    repoRoot: target.repoRoot,
    ...(selectedLensNames === undefined
      ? {}
      : { names: selectedLensNames }),
  })

  const runsRoot = yield* resolveRunsRoot()
  const runId = yield* makeRunId()
  const paths = yield* createRunDirectory(runsRoot, runId)
  // Each lens freezes its final recipe-resolved seat: the recipe maps the
  // lens's finder class to a seat, and later recipe edits never change a
  // resumed run (ADR 0004/0005).
  const frozenLenses = lenses.map((lens) =>
    FrozenLens.make({
      name: lens.name,
      promptText: lens.promptText,
      contentHash: lens.contentHash,
      seat: finderSeat(selected.recipe, lens.finderClass),
      needsSpec: lens.needsSpec,
      ...(lens.category === undefined
        ? {}
        : { category: lens.category }),
      candidateCap: candidateCapForLens(lens.name),
    }))

  const plan = ReviewPlan.make({
    runId,
    createdAt: DateTime.formatIso(startedAt),
    target,
    recipeName: selected.name,
    // Finder seats live on each frozen lens (a mixed standard/deep run has
    // no single Finder seat); only the downstream stages are stage state.
    seats: {
      pool: stageSeat(selected.recipe, "pool"),
      verification: stageSeat(selected.recipe, "verification"),
      judgment: stageSeat(selected.recipe, "judgment"),
    },
    lenses: frozenLenses,
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
  recipe: Option.Option<string>,
  lenses: Option.Option<string>,
  resume: Option.Option<string>,
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
    yield* resumeReview(
      resume.value === LATEST_RESUME_SENTINEL
        ? Option.none()
        : Option.some(resume.value),
    )
    return
  }
  if (Option.isNone(lenses)) {
    yield* startReview(recipe, undefined)
    return
  }
  yield* startReview(
    recipe,
    lenses.value.split(",").map((name) => name.trim()),
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
    lenses: Flag.string("lenses").pipe(
      Flag.optional,
      Flag.withDescription("Run comma-separated named finder lenses"),
    ),
    resume: Flag.string("resume").pipe(
      Flag.optional,
      Flag.withMetavar("[run-id]"),
      Flag.withDescription(
        "Resume a run; omit run-id to select the latest incomplete run",
      ),
    ),
  },
  ({ lenses, recipe, resume }) =>
    executeReviewCommand(recipe, lenses, resume),
).pipe(
  Command.withDescription("Review the working tree's uncommitted changes"),
)

const gauntlet = Command.make("gauntlet").pipe(
  Command.withSubcommands([review, configCommand]),
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
