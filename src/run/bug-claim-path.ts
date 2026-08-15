import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import {
  bundlePoolClusters,
  indexBugClaims,
  numberPoolClusters,
  POOL_SKIP_UNDER,
  type PoolRepair,
  repairPoolOutput,
  singletonClusters,
} from "../assembly/pool.ts"
import { describeMissingOutput } from "../assembly/outcome.ts"
import {
  resolveVerification,
  type VerificationResult,
} from "../assembly/verification.ts"
import {
  assemblePoolPrompt,
  assembleVerifierPrompt,
  EVALUATION_SYSTEM_PROMPT,
  loadEvaluationPromptTemplates,
  POOL_TOOLS,
  VERIFICATION_TOOLS,
} from "../content/evaluation-prompt.ts"
import type { BugClaim } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { invoke } from "../harness/invoke.ts"
import { EmitPool, EmitVerdicts } from "../harness/output-contract.ts"
import { viewBugClaims } from "../render/dossier-view.ts"
import { executeJournaledInvocation } from "./invocation-journal.ts"
import { REVIEW_INVOCATION_DEADLINES } from "./invocation-policy.ts"
import {
  counted,
  coverageGapLine,
  invocationTrail,
  wallSeconds,
} from "./progress-text.ts"
import type { RunPaths } from "./run-record.ts"
import { REVIEW_WORKSPACE_ROOT } from "../workspace/review-workspace.ts"

const progress = Effect.fn("gauntlet.bug_claim_path.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

const initialRepair = (
  claims: ReturnType<typeof indexBugClaims>,
): PoolRepair => ({
  clusters: singletonClusters(claims),
  unknownIndexes: [],
  duplicateIndexes: [],
  restoredIndexes: [],
})

const repairedPoolReason = (repair: PoolRepair): string | undefined => {
  const details = [
    ...(repair.unknownIndexes.length === 0
      ? []
      : [`ignored unknown indexes ${repair.unknownIndexes.join(", ")}`]),
    ...(repair.duplicateIndexes.length === 0
      ? []
      : [`ignored duplicate indexes ${repair.duplicateIndexes.join(", ")}`]),
    ...(repair.restoredIndexes.length === 0
      ? []
      : [`restored singleton indexes ${repair.restoredIndexes.join(", ")}`]),
  ]
  return details.length === 0
    ? undefined
    : `pool output required repair: ${details.join("; ")}`
}

export interface BugClaimPathExecution {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly reviewWorkingDirectory: string
  readonly bugClaims: ReadonlyArray<BugClaim>
}

export interface BugClaimPathResult {
  readonly bugClaims: Dossier["bugClaims"]
  readonly testSuggestions: Dossier["testSuggestions"]
  readonly coverageGaps: Dossier["coverageGaps"]
  readonly costUsd: number
  readonly invocationCount: number
}

export const executeBugClaimPath = Effect.fn(
  "gauntlet.bug_claim_path.execute",
)(function* ({
  bugClaims,
  paths,
  plan,
  reviewWorkingDirectory,
}: BugClaimPathExecution) {
  const claims = indexBugClaims(bugClaims)
  if (claims.length === 0) {
    yield* progress(`skipping Pool (${counted(0, "BugClaim")})`)
    yield* progress(`skipping Verification (${counted(0, "BugClaim")})`)
    return {
      bugClaims: [],
      testSuggestions: [],
      coverageGaps: [],
      costUsd: 0,
      invocationCount: 0,
    } satisfies BugClaimPathResult
  }

  const templates = yield* Effect.cached(loadEvaluationPromptTemplates())
  const coverageGaps: Array<Dossier["coverageGaps"][number]> = []
  let repair = initialRepair(claims)
  let poolCostUsd = 0
  let poolInvocationCount = 0

  let poolStartedAt: DateTime.Utc | undefined
  if (claims.length >= POOL_SKIP_UNDER) {
    const seat = plan.seats.pool
    if (seat === undefined) {
      const reason =
        "pool has no seat frozen in the review plan; used singleton clusters"
      repair = repairPoolOutput(claims, undefined)
      coverageGaps.push({ stage: "pool", reason })
      yield* progress(coverageGapLine({ reason }))
    } else {
      poolStartedAt = yield* DateTime.now
      const journaled = yield* executeJournaledInvocation({
        journalDirectory: paths.journalDirectory,
        runId: plan.runId,
        invocationKey: "pool",
        output: EmitPool.schema,
        execute: Effect.gen(function* () {
          const promptTemplates = yield* templates
          const prompt = yield* assemblePoolPrompt(promptTemplates.pool, claims)
          yield* progress("invoking Pool")
          return yield* invoke({
            seat,
            cwd: reviewWorkingDirectory,
            systemPrompt: EVALUATION_SYSTEM_PROMPT,
            prompt,
            sessionId: `${plan.runId}-pool`,
            contract: EmitPool,
            tools: POOL_TOOLS,
            deadlines: REVIEW_INVOCATION_DEADLINES,
          })
        }),
      })
      if (journaled.reused) {
        yield* progress("reusing Pool from journal")
      }
      yield* progress(
        `Pool done — ${invocationTrail(journaled.outcome.durationMillis, journaled.outcome.usage.costUsd, journaled.outcome.termination)}`,
      )
      repair = repairPoolOutput(claims, journaled.outcome.output)
      poolCostUsd = journaled.outcome.usage.costUsd
      poolInvocationCount = 1
      const repairReason = journaled.outcome.output === undefined
        ? describeMissingOutput("pool", journaled.outcome)
        : repairedPoolReason(repair)
      if (repairReason !== undefined) {
        coverageGaps.push({ stage: "pool", reason: repairReason })
        yield* progress(coverageGapLine({ reason: repairReason }))
      }
    }
  } else {
    yield* progress(`skipping Pool (${counted(claims.length, "BugClaim")})`)
  }

  const clusters = numberPoolClusters(repair.clusters)
  const bundles = bundlePoolClusters(clusters)
  if (poolStartedAt !== undefined) {
    yield* progress(
      `${counted(bundles.length, "bundle")} → Verification`,
    )
    yield* progress(
      `Pool finished — ${String(yield* wallSeconds(poolStartedAt))}s`,
    )
  }
  const verificationSeat = plan.seats.verification
  let verificationResults: ReadonlyArray<VerificationResult> = []
  let verificationStartedAt: DateTime.Utc | undefined
  if (verificationSeat === undefined) {
    const reason =
      "verification has no seat frozen in the review plan; retained every claim as unverified"
    coverageGaps.push({ stage: "verification", reason })
    yield* progress(coverageGapLine({ reason }))
  } else {
    verificationStartedAt = yield* DateTime.now
    verificationResults = yield* Effect.forEach(
      bundles,
      (bundle, index) =>
        Effect.gen(function* () {
          const bundleNumber = index + 1
          const invocationKey = `verification-bundle-${String(bundleNumber)}`
          const journaled = yield* executeJournaledInvocation({
            journalDirectory: paths.journalDirectory,
            runId: plan.runId,
            invocationKey,
            output: EmitVerdicts.schema,
            execute: Effect.gen(function* () {
              const promptTemplates = yield* templates
              // The prompt shows the stable virtual root the tools expose;
              // cwd carries the host snapshot path the overlay mounts on.
              const prompt = yield* assembleVerifierPrompt(
                promptTemplates,
                plan.target,
                REVIEW_WORKSPACE_ROOT,
                claims,
                bundle,
                plan.specification,
              )
              yield* progress(
                `invoking Verification bundle ${String(bundleNumber)}`,
              )
              return yield* invoke({
                seat: verificationSeat,
                cwd: reviewWorkingDirectory,
                systemPrompt: EVALUATION_SYSTEM_PROMPT,
                prompt,
                // Bundles run concurrently, so a shared cache partition buys
                // nothing; per-bundle ids keep logs and scripts attributable.
                sessionId: `${plan.runId}-verification-${String(bundleNumber)}`,
                contract: EmitVerdicts,
                tools: VERIFICATION_TOOLS,
                deadlines: REVIEW_INVOCATION_DEADLINES,
              })
            }),
          })
          if (journaled.reused) {
            yield* progress(
              `reusing Verification bundle ${String(bundleNumber)} from journal`,
            )
          }
          yield* progress(
            `Verification bundle ${String(bundleNumber)} done — ${invocationTrail(journaled.outcome.durationMillis, journaled.outcome.usage.costUsd, journaled.outcome.termination)}`,
          )
          return {
            bundleNumber,
            clusters: bundle,
            outcome: journaled.outcome,
          } satisfies VerificationResult
        }),
      { concurrency: "unbounded" },
    )
  }

  const resolved = resolveVerification(claims, clusters, verificationResults)
  for (const gap of resolved.coverageGaps) {
    yield* progress(coverageGapLine(gap))
  }
  if (verificationStartedAt !== undefined) {
    const tally = viewBugClaims(resolved.bugClaims)
    yield* progress(
      `Verification finished — ${String(tally.confirmed.length)} confirmed · ${String(tally.refuted.length)} refuted · ${String(tally.unverified.length)} unverified · ${String(yield* wallSeconds(verificationStartedAt))}s`,
    )
  }
  return {
    bugClaims: resolved.bugClaims,
    testSuggestions: resolved.testSuggestions,
    coverageGaps: [...coverageGaps, ...resolved.coverageGaps],
    costUsd:
      poolCostUsd +
      Array.reduce(
        verificationResults,
        0,
        (total, result) => total + result.outcome.usage.costUsd,
      ),
    invocationCount: poolInvocationCount + verificationResults.length,
  } satisfies BugClaimPathResult
})
