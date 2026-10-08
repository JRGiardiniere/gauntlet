import type * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import type * as PlatformError from "effect/PlatformError"
import {
  type RecipeCatalogError,
  type RecipeSelectionError,
  renderAvailable,
} from "../config/recipe-catalog.ts"
import { resolveRunsRoot, type SettingsError } from "../config/settings.ts"
import type { ContentLoadError } from "../content/lens.ts"
import type { PromptAssemblyError } from "../content/prompt-template.ts"
import type { CoverageGap } from "../domain/dossier.ts"
import { deliverCompletedRun, DeliveryError } from "../delivery/delivery.ts"
import type {
  AdapterContractViolation,
  InvocationSetupError,
} from "../harness/harness-session.ts"
import {
  loadCallerAddendum,
  type SpecificationLoadError,
} from "../specification/caller-addendum.ts"
import type { TargetUnresolvable } from "../target/git.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import {
  type ArtifactWriteError,
  describeArtifactWrite,
  describePlatformError,
} from "./artifact.ts"
import { executeReviewPlan } from "./review-executor.ts"
import { loadRun, type RunError, type RunPaths } from "./run-record.ts"
import {
  submit,
  type SubmissionError,
  type SubmissionRequest,
} from "./submission.ts"

// The Run module: the two things a Host asks of Gauntlet, reviewing a request
// and delivering a finished Run, each answered as data. Nothing here prints a
// result or names a Host's command; the CLI and the Mod each word what comes
// back their own way (#159).

// What a review asks for, as both Hosts' shared syntax types it.
export interface ReviewRequest extends Omit<SubmissionRequest, "addendum"> {
  // The checkout the review runs in.
  readonly directory: string
  // The Caller Addendum's Markdown file, already resolved.
  readonly specPath: string | undefined
}

// A review that produced its Dossier: zero findings included, coverage gaps
// included.
export interface Reviewed {
  readonly runId: string
  readonly paths: RunPaths
  readonly digest: string
  readonly coverageGaps: ReadonlyArray<CoverageGap>
}

// Why a review could not run, or a Run could not be posted, as one line every
// Host shows as it stands.
export class RunRefusal extends Data.TaggedError("RunRefusal")<{
  readonly reason: string
  // A failed post may still have landed (gh can fail after posting, and a
  // posted comment's receipt can fail to save), so a blind retry could post
  // twice: the Run whose pull request to check before delivering it again.
  readonly unconfirmedPost?: string
  // Gauntlet has no configuration to choose a Recipe or Lenses from: the Host
  // says how its person sets it up.
  readonly unconfigured?: boolean
}> {}

// Everything that stops a review or a delivery before it can answer.
export type RunFailure =
  | AdapterContractViolation
  | ArtifactWriteError
  | Config.ConfigError
  | ContentLoadError
  | DeliveryError
  | InvocationSetupError
  | PlatformError.PlatformError
  | PromptAssemblyError
  | RecipeCatalogError
  | RecipeSelectionError
  | RunError
  | SettingsError
  | SpecificationLoadError
  | SubmissionError
  | TargetUnresolvable

export const refusalOf = (failure: RunFailure): RunRefusal => {
  switch (failure._tag) {
    // Configuration failures stand alone: their reasons already name the
    // file or recipe at fault.
    case "SettingsError":
    case "RecipeCatalogError":
      return new RunRefusal({ reason: `${failure.reason} (${failure.path})` })
    case "RecipeSelectionError":
      return new RunRefusal({
        reason: `could not review — ${failure.reason}${
          renderAvailable(failure.available)
        }`,
        unconfigured: failure.available.length === 0,
      })
    case "DeliveryError":
      return failure.operation === "post" && failure.runId !== undefined
        ? new RunRefusal({
          reason: `could not deliver — ${failure.reason}`,
          unconfirmedPost: failure.runId,
        })
        : new RunRefusal({ reason: `could not deliver — ${failure.reason}` })
    case "ArtifactWriteError":
      return new RunRefusal({
        reason: `could not review — ${describeArtifactWrite(failure)}`,
      })
    case "ContentLoadError":
    case "SpecificationLoadError":
      return new RunRefusal({
        reason: `could not review — ${failure.reason} (${failure.path})`,
      })
    case "InvocationSetupError":
      return new RunRefusal({
        reason:
          `could not review — invocation ${failure.operation}: ${failure.reason}`,
      })
    case "PlatformError":
      return new RunRefusal({
        reason: `could not review — ${describePlatformError(failure)}`,
      })
    case "ConfigError":
      return new RunRefusal({ reason: `could not review — ${failure.message}` })
    case "SubmissionError":
      return new RunRefusal({
        reason: `could not review — ${failure.reason}`,
        unconfigured: failure.unconfigured === true,
      })
    default:
      return new RunRefusal({ reason: `could not review — ${failure.reason}` })
  }
}

// Reviews the request to its Dossier: Submission, the Stages and the run
// record. Posting the Dossier is `deliver`'s alone, which a Host calls once it
// has shown the digest.
export const review = Effect.fn("Run.review")(
  function* (request: ReviewRequest) {
    const startedAt = yield* DateTime.now
    // An explicitly named unusable addendum fails here, before any Run
    // exists (issue #73): the caller selected the file, so absence is never
    // quiet.
    const addendum = request.specPath === undefined
      ? undefined
      : yield* loadCallerAddendum(request.specPath)
    const loaded = yield* submit({ ...request, addendum })
    const { coverageGaps, digest } = yield* executeReviewPlan({
      ...loaded,
      startedAt,
    })
    return {
      runId: loaded.plan.runId,
      paths: loaded.paths,
      digest,
      coverageGaps,
    } satisfies Reviewed
  },
  (effect, request) =>
    effect.pipe(
      Effect.mapError(refusalOf),
      Effect.provideService(InvocationDirectory, request.directory),
    ),
)

// Posts a completed pull-request Run's Dossier, answering its receipt; a Run
// already posted answers the receipt it has.
export const deliver = Effect.fn("Run.deliver")(
  function* (runId: string) {
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
    return yield* deliverCompletedRun(loaded)
  },
  Effect.mapError(refusalOf),
)
