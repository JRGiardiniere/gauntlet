import * as Array from "effect/Array"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { clusterEvaluatedBugClaims } from "../../assembly/bug-claim-cluster.ts"
import type {
  CoverageGap,
  EvaluatedBugClaim,
  TestSuggestion,
} from "../../domain/dossier.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import { Verdict } from "../../domain/verdict.ts"
import { HarnessSessionFactory } from "../../harness/harness-session.ts"
import {
  counted,
  coverageGapLine,
  runProgress,
  wallSeconds,
} from "../../run/progress-text.ts"
import { invokeStageAgent } from "../evaluation.ts"
import type { PooledBugClaims } from "../pool/pool.ts"
import { EmitVerdicts } from "./output-contract.ts"
import {
  assembleVerifierPrompt,
  loadVerifierPromptTemplates,
} from "./prompt.ts"
import { resolveVerification, type VerifiedBundle } from "./resolution.ts"

const VERIFIER_BUNDLE_SIZE = 4

const VERIFICATION_TOOLS = ["read", "bash"] as const

export interface VerificationExecution {
  readonly plan: ReviewPlan
  readonly reviewWorkingDirectory: string
  readonly pooled: PooledBugClaims
}

export interface VerificationResult {
  readonly bugClaims: ReadonlyArray<EvaluatedBugClaim>
  readonly testSuggestions: ReadonlyArray<TestSuggestion>
  readonly coverageGaps: ReadonlyArray<CoverageGap>
  readonly costUsd: number
  readonly invocationCount: number
}

// The Run learns Verification only through this interface. Pool's clusters
// go out in verifier bundles of four, one invocation each, side by side.
export const executeVerification = Effect.fn("Verification.execute")(function* ({
  plan,
  pooled,
  reviewWorkingDirectory,
}: VerificationExecution) {
  if (pooled.claims.length === 0) {
    yield* runProgress(`skipping Verification (${counted(0, "BugClaim")})`)
    return {
      bugClaims: [],
      testSuggestions: [],
      coverageGaps: [],
      costUsd: 0,
      invocationCount: 0,
    } satisfies VerificationResult
  }

  const seat = plan.seats.verification
  if (seat === undefined) {
    const reason =
      "verification has no seat frozen in the review plan; retained every claim as plausible without examination"
    yield* runProgress(coverageGapLine({ reason }))
    return {
      bugClaims: resolveVerification(pooled, []).bugClaims,
      testSuggestions: [],
      coverageGaps: [{ stage: "verification", reason }],
      costUsd: 0,
      invocationCount: 0,
    } satisfies VerificationResult
  }

  const verificationStartedAt = yield* DateTime.now
  const host = yield* HarnessSessionFactory
  const templates = yield* loadVerifierPromptTemplates(host.workspacePrompt)
  const bundles = Array.chunksOf(pooled.clusters, VERIFIER_BUNDLE_SIZE)
  yield* runProgress(`${counted(bundles.length, "bundle")} → Verification`)
  const verified = yield* Effect.forEach(
    bundles,
    (clusters, index) =>
      Effect.gen(function* () {
        const bundleNumber = index + 1
        // The prompt shows the root the host's tools expose (Pi's stable
        // virtual root); cwd carries the snapshot path itself.
        const prompt = yield* assembleVerifierPrompt(
          templates,
          plan.target,
          host.workspaceRoot(reviewWorkingDirectory),
          pooled.claims,
          clusters,
          plan.specification,
        )
        const outcome = yield* invokeStageAgent({
          label: `Verification bundle ${String(bundleNumber)}`,
          invocationId: `${plan.runId}-verification-${String(bundleNumber)}`,
          seat,
          cwd: reviewWorkingDirectory,
          prompt,
          contract: EmitVerdicts,
          tools: VERIFICATION_TOOLS,
        })
        return { bundleNumber, clusters, outcome } satisfies VerifiedBundle
      }),
    { concurrency: "unbounded" },
  )

  const resolved = resolveVerification(pooled, verified)
  for (const gap of resolved.coverageGaps) {
    yield* runProgress(coverageGapLine(gap))
  }
  const verdicts = clusterEvaluatedBugClaims(resolved.bugClaims).map(
    ({ verdict }) => verdict,
  )
  const confirmed = verdicts.filter(Verdict.guards.Confirmed).length
  const refuted = verdicts.filter(Verdict.guards.Refuted).length
  const plausible = verdicts.filter(Verdict.guards.Plausible).length
  yield* runProgress(
    `Verification finished — ${String(confirmed)} confirmed · ${String(refuted)} refuted · ${String(plausible)} plausible · ${String(yield* wallSeconds(verificationStartedAt))}s`,
  )
  return {
    ...resolved,
    costUsd: Array.reduce(
      verified,
      0,
      (total, { outcome }) => total + outcome.usage.costUsd,
    ),
    invocationCount: verified.length,
  } satisfies VerificationResult
})
