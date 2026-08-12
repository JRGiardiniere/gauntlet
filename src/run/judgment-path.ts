import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import { indexObservations, resolveJudgment } from "../assembly/judgment.ts"
import { describeMissingOutput } from "../assembly/outcome.ts"
import {
  assembleJudgmentPrompt,
  EVALUATION_SYSTEM_PROMPT,
  JUDGMENT_TOOLS,
  loadJudgmentPromptTemplates,
} from "../content/evaluation-prompt.ts"
import type { Observation } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { invoke } from "../harness/invoke.ts"
import { EmitJudgments } from "../harness/output-contract.ts"
import { executeJournaledInvocation } from "./invocation-journal.ts"
import { REVIEW_INVOCATION_DEADLINES } from "./invocation-policy.ts"
import type { RunPaths } from "./run-record.ts"
import { ensureWorkingTreeUnchanged } from "./target-consistency.ts"

const progress = Effect.fn("gauntlet.judgment_path.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

const repairReason = (notes: ReadonlyArray<string>): string | undefined =>
  notes.length === 0
    ? undefined
    : `judgment output required repair: ${notes.join("; ")}`

export interface JudgmentPathExecution {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly observations: ReadonlyArray<Observation>
}

export interface JudgmentPathResult {
  readonly observations: Dossier["observations"]
  readonly coverageGaps: Dossier["coverageGaps"]
  readonly costUsd: number
  readonly invocationCount: number
}

export const executeJudgmentPath = Effect.fn(
  "gauntlet.judgment_path.execute",
)(function* ({ observations, paths, plan }: JudgmentPathExecution) {
  const indexed = indexObservations(observations)
  if (indexed.length === 0) {
    return {
      observations: [],
      coverageGaps: [],
      costUsd: 0,
      invocationCount: 0,
    } satisfies JudgmentPathResult
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
    } satisfies JudgmentPathResult
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
  } satisfies JudgmentPathResult
})
