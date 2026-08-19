import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { DeliveryReceipt } from "../domain/delivery-receipt.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { GitHub } from "../github/github.ts"
import {
  readOptionalArtifactText,
  writeArtifactJson,
} from "../run/artifact.ts"
import type { LoadedRun } from "../run/run-record.ts"
import { fitPostedDossier } from "./comment-body.ts"

export class DeliveryError extends Data.TaggedError("DeliveryError")<{
  readonly operation: "load" | "post"
  readonly reason: string
  readonly runId?: string
  readonly cause?: unknown
}> {}

const decodeReceipt = Schema.decodeUnknownEffect(
  Schema.fromJsonString(DeliveryReceipt),
)

const readDeliveryArtifact = (
  path: string,
  runId: string,
  what: string,
) =>
  readOptionalArtifactText(path).pipe(
    Effect.mapError((cause) =>
      new DeliveryError({
        operation: "load",
        reason: `could not read ${what} for run ${runId}`,
        runId,
        cause,
      })),
  )

// Destination is not in the frozen plan (ADR 0005). Callers that would
// otherwise pay remaining invocations must refuse a working-tree run first.
export const requirePullRequestTarget = (
  plan: ReviewPlan,
): Effect.Effect<
  Extract<ReviewTarget, { readonly _tag: "PullRequest" }>,
  DeliveryError
> =>
  ReviewTarget.guards.PullRequest(plan.target)
    ? Effect.succeed(plan.target)
    : Effect.fail(
      new DeliveryError({
        operation: "load",
        reason:
          `run ${plan.runId} is not a pull-request review and has no pull-request destination`,
        runId: plan.runId,
      }),
    )

const loadReceipt = Effect.fn("gauntlet.delivery.load_receipt")(
  function* (paths: LoadedRun["paths"], runId: string) {
    const source = yield* readDeliveryArtifact(
      paths.receipt,
      runId,
      "delivery receipt",
    )
    if (Option.isNone(source)) return Option.none<DeliveryReceipt>()
    const receipt = yield* decodeReceipt(source.value).pipe(
      Effect.mapError((cause) =>
        new DeliveryError({
          operation: "load",
          reason: `delivery receipt for run ${runId} is corrupt`,
          runId,
          cause,
        })),
    )
    if (receipt.runId !== runId) {
      return yield* new DeliveryError({
        operation: "load",
        reason:
          `delivery receipt belongs to run ${receipt.runId}, not ${runId}`,
        runId,
      })
    }
    return Option.some(receipt)
  },
)

const requireMarkdown = Effect.fn("gauntlet.delivery.require_markdown")(
  function* (paths: LoadedRun["paths"], runId: string) {
    const source = yield* readDeliveryArtifact(
      paths.dossierMarkdown,
      runId,
      "dossier.md",
    )
    if (Option.isNone(source) || source.value.length === 0) {
      return yield* new DeliveryError({
        operation: "load",
        reason: `run ${runId} is not complete`,
        runId,
      })
    }
    return source.value
  },
)

// Posts a completed PR-targeted Run's dossier.md as one PR comment. A Posted
// receipt is an idempotent no-op; NotPosted may be retried. Failure writes
// NotPosted and never touches the review artifacts (ADR 0005, ADR 0006).
export const deliverCompletedRun = Effect.fn(
  "gauntlet.delivery.deliver_completed_run",
)(function* (loaded: LoadedRun) {
  const { paths, plan } = loaded
  const target = yield* requirePullRequestTarget(plan)
  const existing = yield* loadReceipt(paths, plan.runId)
  if (Option.isSome(existing) && DeliveryReceipt.guards.Posted(existing.value)) {
    return existing.value
  }

  const markdown = yield* requireMarkdown(paths, plan.runId)
  const fitted = fitPostedDossier(markdown)
  const github = yield* GitHub
  const posted = yield* github.postComment(
    target.repoRoot,
    target.number,
    fitted.body,
  ).pipe(
    Effect.map((result) =>
      DeliveryReceipt.cases.Posted.make({
        runId: plan.runId,
        url: result.url,
        truncated: fitted.truncated,
      })),
    Effect.catchTag("GitHubError", (cause) =>
      Effect.succeed(
        DeliveryReceipt.cases.NotPosted.make({
          runId: plan.runId,
          reason: cause.reason,
        }),
      )),
  )
  yield* writeArtifactJson(paths.receipt, DeliveryReceipt, posted).pipe(
    Effect.mapError((cause) =>
      new DeliveryError({
        operation: "post",
        reason: `failed to write ${cause.path}`,
        runId: plan.runId,
        cause,
      })),
  )
  if (DeliveryReceipt.guards.NotPosted(posted)) {
    return yield* new DeliveryError({
      operation: "post",
      reason: posted.reason,
      runId: plan.runId,
    })
  }
  return posted
})
