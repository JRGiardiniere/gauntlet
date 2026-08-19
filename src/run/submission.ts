import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { resolveReviewRecipe } from "../config/recipe-catalog.ts"
import { loadSettings, resolveRunsRoot } from "../config/settings.ts"
import { loadFinderLenses } from "../content/lens.ts"
import { resolveLensNames } from "../domain/lens-selection.ts"
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
import { InvocationDirectory } from "../target/invocation-directory.ts"
import { resolvePullRequestTarget } from "../target/pull-request.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
import { writeArtifactBytes, writeArtifactJson } from "./artifact.ts"
import { captureWorkspaceOverlay } from "./review-working-directory.ts"
import {
  createRunDirectory,
  makeRunId,
  type LoadedRun,
} from "./run-record.ts"

// Submission turns a caller's review request into a persisted Run
// (CONTEXT.md): one entry point, a parsed SubmissionRequest in, the loaded
// Run out. Submission ends when the Run is persisted — execution, resume,
// and delivery stay with the caller.

// Assembly refusals — the request parsed but no Run can be assembled from it.
export class SubmissionError extends Data.TaggedError("SubmissionError")<{
  readonly reason: string
}> {}

const progress = Effect.fn("gauntlet.submission.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

// The caller aims explicitly (ADR 0005), and the tagged request makes only
// the valid aims representable: a GitHub-pinned Specification Source belongs
// to a pull-request aim, and a base range extends only a working-tree aim.
export type SubmissionTargetRequest = Data.TaggedEnum<{
  PullRequest: {
    readonly number: number
    // Use only GitHub closing issues as the Specification Source for this Run.
    readonly githubSpecOnly: boolean
  }
  Commits: { readonly range: string }
  // A present base means the committed range extended to the working tree as
  // submitted; absent means the uncommitted changes against HEAD alone.
  WorkingTree: { readonly base: string | undefined }
}>
export const SubmissionTargetRequest = Data.taggedEnum<SubmissionTargetRequest>()

export interface SubmissionRequest {
  readonly target: SubmissionTargetRequest
  readonly recipeName: Option.Option<string>
  // undefined selects the configured Default Lenses; an array is the caller's
  // exact selection, used verbatim without consulting settings.
  readonly selectedLensNames: ReadonlyArray<string> | undefined
  readonly addendum: ReviewSpecification | undefined
}

const resolveTarget = Effect.fn("gauntlet.submission.resolve_target")(
  function* (request: SubmissionTargetRequest) {
    const directory = yield* InvocationDirectory
    if (SubmissionTargetRequest.$is("PullRequest")(request)) {
      yield* progress(`resolving PR #${String(request.number)} review target`)
      return yield* resolvePullRequestTarget(directory, request.number)
    }
    if (SubmissionTargetRequest.$is("Commits")(request)) {
      yield* progress(`resolving ${request.range} review target`)
      return yield* resolveCommitsTarget(directory, request.range)
    }
    if (request.base !== undefined) {
      yield* progress(
        `resolving ${request.base} plus working-tree review target`,
      )
      return yield* resolveWorkingTreeTarget(directory, request.base)
    }
    yield* progress("resolving working-tree review target")
    return yield* resolveWorkingTreeTarget(directory, undefined)
  },
)

const resolveSpecificationBranch = Effect.fn(
  "gauntlet.submission.resolve_specification_branch",
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

interface AcquiredSpecification {
  readonly specification: ReviewSpecification | undefined
  readonly diagnostic: SpecificationSourceDiagnostic | undefined
}

const acquireSpecification = Effect.fn(
  "gauntlet.submission.acquire_specification",
)(function* (
  request: SubmissionTargetRequest,
  target: ReviewTarget,
  addendum: ReviewSpecification | undefined,
) {
  const githubOnly =
    SubmissionTargetRequest.$is("PullRequest")(request) && request.githubSpecOnly
  const branch = yield* resolveSpecificationBranch(target.repoRoot)
  const linear = githubOnly ? undefined : yield* loadLinearSpecification(branch)
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
  if (githubOnly && fetched === undefined) {
    return yield* new SubmissionError({
      reason:
        "--github-spec could not resolve a ReviewSpecification from GitHub closing issues",
    })
  }
  return {
    specification: combineReviewSpecifications(fetched, addendum),
    diagnostic,
  } satisfies AcquiredSpecification
})

export const submit = Effect.fn("gauntlet.submission.submit")(function* (
  request: SubmissionRequest,
) {
  // Recipe selection fails before any Run exists (issue #24): positional
  // recipe, otherwise the configured Default Recipe — nothing else.
  const selected = yield* resolveReviewRecipe(request.recipeName)
  yield* progress(`using recipe ${selected.name}`)
  const defaultLensNames = request.selectedLensNames === undefined
    ? yield* Effect.gen(function* () {
        const settings = yield* loadSettings()
        if (Option.isNone(settings)) {
          return yield* new SubmissionError({
            reason:
              "no Default Lenses are configured — pass --lenses or run `gauntlet config init`",
          })
        }
        return settings.value["default-lenses"]
      })
    : []
  const target = yield* resolveTarget(request.target)
  // Scope degradation is never silent (spec #16): each warning is narrated
  // as it is discovered, in addition to landing on the plan and report.
  for (const warning of target.warnings) {
    yield* progress(`warning — ${warning}`)
  }
  // Uncommitted state is the one input Git cannot reconstruct from the frozen
  // head commit, so it is captured while the resolved target is still current
  // — before Lenses load, before any other paid work.
  const overlay = ReviewTarget.guards.WorkingTree(target)
    ? yield* Effect.scoped(captureWorkspaceOverlay(target))
    : undefined

  const resolvedLensNames = resolveLensNames(
    request.selectedLensNames,
    defaultLensNames,
  )
  yield* progress(
    request.selectedLensNames === undefined
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

  const { diagnostic, specification } = yield* acquireSpecification(
    request.target,
    target,
    request.addendum,
  )
  if (diagnostic !== undefined) {
    yield* progress(`warning — ${diagnostic.message}`)
  }

  // The run directory exists only once every resolution has succeeded: a
  // refused submission leaves nothing behind.
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
  const plan = specification === undefined
    ? diagnostic === undefined
      ? ReviewPlan.make(planFields)
      : ReviewPlan.make({
          ...planFields,
          specificationSourceDiagnostic: diagnostic,
        })
    : diagnostic === undefined
      ? ReviewPlan.make({ ...planFields, specification })
      : ReviewPlan.make({
          ...planFields,
          specification,
          specificationSourceDiagnostic: diagnostic,
        })
  yield* progress("freezing review plan")
  // Overlay first: a persisted plan implies its overlay exists.
  if (overlay !== undefined) {
    yield* writeArtifactBytes(paths.workspaceOverlay, overlay)
  }
  yield* writeArtifactJson(paths.plan, ReviewPlan, plan)
  return { paths, plan } satisfies LoadedRun
})
