import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { describeMissingOutput } from "../../assembly/outcome.ts"
import { EVALUATION_SYSTEM_PROMPT } from "../../content/evaluation-prompt.ts"
import type { Observation } from "../../domain/candidate.ts"
import type { Dossier } from "../../domain/dossier.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import { invoke } from "../../harness/invoke.ts"
import { executeJournaledInvocation } from "../../run/invocation-journal.ts"
import { REVIEW_INVOCATION_DEADLINES } from "../../run/invocation-policy.ts"
import type { RunPaths } from "../../run/run-record.ts"
import { ensureWorkingTreeUnchanged } from "../../run/target-consistency.ts"
import { EmitJudgments } from "./output-contract.ts"
import {
  assembleJudgmentPrompt,
  loadJudgmentPromptTemplates,
} from "./prompt.ts"
import { indexObservations, resolveJudgment } from "./resolution.ts"

export const JUDGMENT_TOOLS = ["read", "bash"] as const

const progress = Effect.fn("gauntlet.judgment.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

const repairReason = (notes: ReadonlyArray<string>): string | undefined =>
  notes.length === 0
    ? undefined
    : `judgment output required repair: ${notes.join("; ")}`

export interface JudgmentExecution {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly observations: ReadonlyArray<Observation>
}

export interface JudgmentResult {
  readonly observations: Dossier["observations"]
  readonly coverageGaps: Dossier["coverageGaps"]
  readonly costUsd: number
  readonly invocationCount: number
}

// The Run learns Judgment only through this interface: prompt, contract,
// resolution, and repair semantics all live behind it.
export const executeJudgment = Effect.fn(
  "gauntlet.judgment.execute",
)(function* ({ observations, paths, plan }: JudgmentExecution) {
  const indexed = indexObservations(observations)
  if (indexed.length === 0) {
    return {
      observations: [],
      coverageGaps: [],
      costUsd: 0,
      invocationCount: 0,
    } satisfies JudgmentResult
  }

  const seat = plan.seats.judgment
  if (seat === undefined) {
    const repair = resolveJudgment(indexed, undefined)
    return {
      observations: repair.observations,
      coverageGaps: [{
        stage: "judgment",
        reason:
          "judgment has no seat frozen in the review plan; retained every observation as undecided",
      }],
      costUsd: 0,
      invocationCount: 0,
    } satisfies JudgmentResult
  }

  const journaled = yield* executeJournaledInvocation({
    journalDirectory: paths.journalDirectory,
    runId: plan.runId,
    invocationKey: "judgment",
    output: EmitJudgments.schema,
    execute: Effect.gen(function* () {
      yield* ensureWorkingTreeUnchanged(plan)
      const promptTemplates = yield* loadJudgmentPromptTemplates()
      const prompt = yield* assembleJudgmentPrompt(
        promptTemplates,
        plan.target,
        plan.specText,
        indexed,
      )
      yield* progress("invoking Judgment")
      return yield* invoke({
        seat,
        cwd: plan.target.repoRoot,
        systemPrompt: EVALUATION_SYSTEM_PROMPT,
        prompt,
        sessionId: `${plan.runId}-judgment`,
        contract: EmitJudgments,
        tools: JUDGMENT_TOOLS,
        deadlines: REVIEW_INVOCATION_DEADLINES,
      })
    }),
  })
  if (journaled.reused) yield* progress("reusing Judgment from journal")

  const repair = resolveJudgment(indexed, journaled.outcome.output)
  const reason = journaled.outcome.output === undefined
    ? describeMissingOutput("judgment", journaled.outcome)
    : repairReason(repair.notes)
  return {
    observations: repair.observations,
    coverageGaps: reason === undefined
      ? []
      : [{ stage: "judgment", reason }],
    costUsd: journaled.outcome.usage.costUsd,
    invocationCount: 1,
  } satisfies JudgmentResult
})
