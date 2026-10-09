import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import { describeMissingOutput } from "../../domain/agent-outcome.ts"
import type { Observation } from "../../domain/candidate.ts"
import type {
  CoverageGap,
  JudgedObservation,
} from "../../domain/dossier.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import { Judgment } from "../../domain/judgment.ts"
import { HarnessSessionFactory } from "../../harness/harness-session.ts"
import {
  counted,
  coverageGapLine,
  runProgress,
  wallSeconds,
} from "../../run/progress-text.ts"
import { invokeStageAgent } from "../evaluation.ts"
import type { PooledBugClaims } from "../pool/pool.ts"
import { EmitJudgments } from "./output-contract.ts"
import {
  assembleJudgmentPrompt,
  loadJudgmentPromptTemplates,
} from "./prompt.ts"
import { indexObservations, resolveJudgment } from "./resolution.ts"

export const JUDGMENT_TOOLS = ["read", "bash"] as const

const repairReason = (notes: ReadonlyArray<string>): string | undefined =>
  notes.length === 0
    ? undefined
    : `judgment output required repair: ${notes.join("; ")}`

export interface JudgmentExecution {
  readonly plan: ReviewPlan
  readonly reviewWorkingDirectory: string
  readonly observations: ReadonlyArray<Observation>
  // Pool's BugClaim clusters, which an Observation must not restate.
  readonly pooled: PooledBugClaims
}

export interface JudgmentResult {
  readonly observations: ReadonlyArray<JudgedObservation>
  readonly coverageGaps: ReadonlyArray<CoverageGap>
  readonly costUsd: number
  readonly invocationCount: number
}

// The Run learns Judgment only through this interface: prompt, contract,
// resolution, and repair semantics all live behind it.
export const executeJudgment = Effect.fn(
  "gauntlet.judgment.execute",
)(function* ({
  observations,
  plan,
  pooled,
  reviewWorkingDirectory,
}: JudgmentExecution) {
  const indexed = indexObservations(observations)
  if (indexed.length === 0) {
    yield* runProgress(`skipping Judgment (${counted(0, "Observation")})`)
    return {
      observations: [],
      coverageGaps: [],
      costUsd: 0,
      invocationCount: 0,
    } satisfies JudgmentResult
  }

  const seat = plan.seats.judgment
  if (seat === undefined) {
    const reason =
      "judgment has no seat frozen in the review plan; retained every observation as undecided"
    const repair = resolveJudgment(indexed, undefined)
    yield* runProgress(coverageGapLine({ reason }))
    return {
      observations: repair.observations,
      coverageGaps: [{ stage: "judgment", reason }],
      costUsd: 0,
      invocationCount: 0,
    } satisfies JudgmentResult
  }

  const judgmentStartedAt = yield* DateTime.now
  const host = yield* HarnessSessionFactory
  const promptTemplates = yield* loadJudgmentPromptTemplates(
    host.workspacePrompt,
  )
  // The prompt shows the root the host's tools expose (Pi's stable virtual
  // root); cwd carries the snapshot path itself.
  const prompt = yield* assembleJudgmentPrompt(
    promptTemplates,
    plan.target,
    host.workspaceRoot(reviewWorkingDirectory),
    indexed,
    plan.specification,
    pooled,
  )
  const outcome = yield* invokeStageAgent({
    label: "Judgment",
    invocationId: `${plan.runId}-judgment`,
    seat,
    cwd: reviewWorkingDirectory,
    prompt,
    contract: EmitJudgments,
    tools: JUDGMENT_TOOLS,
  })

  const repair = resolveJudgment(indexed, outcome.output)
  const reason = outcome.output === undefined
    ? describeMissingOutput("judgment", outcome)
    : repairReason(repair.notes)
  if (reason !== undefined) {
    yield* runProgress(coverageGapLine({ reason }))
  }
  const judgments = repair.observations.map(({ judgment }) => judgment)
  const kept = judgments.filter(Judgment.guards.Kept).length
  const dropped = judgments.filter(Judgment.guards.Dropped).length
  const undecided = judgments.filter(Judgment.guards.Undecided).length
  yield* runProgress(
    `Judgment finished — ${String(kept)} kept · ${String(dropped)} dropped · ${String(undecided)} undecided · ${String(yield* wallSeconds(judgmentStartedAt))}s`,
  )
  return {
    observations: repair.observations,
    coverageGaps: reason === undefined
      ? []
      : [{ stage: "judgment", reason }],
    costUsd: outcome.usage.costUsd,
    invocationCount: 1,
  } satisfies JudgmentResult
})
