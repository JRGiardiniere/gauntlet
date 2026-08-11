import * as Array from "effect/Array"
import * as Console from "effect/Console"
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
import { executeJournaledInvocation } from "./invocation-journal.ts"
import { REVIEW_INVOCATION_DEADLINES } from "./invocation-policy.ts"
import type { RunPaths } from "./run-record.ts"
import { ensureWorkingTreeUnchanged } from "./target-consistency.ts"

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
  readonly bugClaims: ReadonlyArray<BugClaim>
}

export interface BugClaimPathResult {
  readonly bugClaims: Dossier["bugClaims"]
  readonly coverageGaps: Dossier["coverageGaps"]
  readonly costUsd: number
  readonly invocationCount: number
}

export const executeBugClaimPath = Effect.fn(
  "gauntlet.bug_claim_path.execute",
)(function* ({ bugClaims, paths, plan }: BugClaimPathExecution) {
  const claims = indexBugClaims(bugClaims)
  if (claims.length === 0) {
    return {
      bugClaims: [],
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

  if (claims.length >= POOL_SKIP_UNDER) {
    const seat = plan.seats.pool
    if (seat === undefined) {
      repair = repairPoolOutput(claims, undefined)
      coverageGaps.push({
        stage: "pool",
        reason: "pool has no seat frozen in the review plan; used singleton clusters",
      })
    } else {
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
            cwd: plan.target.repoRoot,
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
      repair = repairPoolOutput(claims, journaled.outcome.output)
      poolCostUsd = journaled.outcome.usage.costUsd
      poolInvocationCount = 1
      const repairReason = journaled.outcome.output === undefined
        ? describeMissingOutput("pool", journaled.outcome)
        : repairedPoolReason(repair)
      if (repairReason !== undefined) {
        coverageGaps.push({ stage: "pool", reason: repairReason })
      }
    }
  }

  const bundles = bundlePoolClusters(numberPoolClusters(repair.clusters))
  const verificationSeat = plan.seats.verification
  let verificationResults: ReadonlyArray<VerificationResult> = []
  if (verificationSeat === undefined) {
    coverageGaps.push({
      stage: "verification",
      reason:
        "verification has no seat frozen in the review plan; retained every claim as unverified",
    })
  } else {
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
              yield* ensureWorkingTreeUnchanged(plan)
              const promptTemplates = yield* templates
              const prompt = yield* assembleVerifierPrompt(
                promptTemplates,
                plan.target,
                plan.specText,
                claims,
                bundle,
              )
              yield* progress(
                `invoking Verification bundle ${String(bundleNumber)}`,
              )
              return yield* invoke({
                seat: verificationSeat,
                cwd: plan.target.repoRoot,
                systemPrompt: EVALUATION_SYSTEM_PROMPT,
                prompt,
                sessionId: `${plan.runId}-verification`,
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
          return {
            bundleNumber,
            clusters: bundle,
            outcome: journaled.outcome,
          } satisfies VerificationResult
        }),
      { concurrency: "unbounded" },
    )
  }

  const resolved = resolveVerification(claims, verificationResults)
  return {
    bugClaims: resolved.bugClaims,
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
