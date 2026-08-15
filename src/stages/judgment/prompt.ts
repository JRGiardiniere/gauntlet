import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { formatCandidateLine } from "../../content/candidate-line.ts"
import {
  assembleStageScope,
  loadStageScopeTemplate,
} from "../../content/evaluation-prompt.ts"
import { ContentLoadError } from "../../content/lens.ts"
import {
  type PromptAssemblyError,
  renderPromptTemplate,
} from "../../content/prompt-template.ts"
import type { ReviewSpecification } from "../../domain/review-specification.ts"
import type { ReviewTarget } from "../../domain/review-target.ts"
import type { IndexedObservation } from "./resolution.ts"

// The judge template ships with this Stage module, so stage tests exercise
// the same prompt text a real run pays for. The scope block stays in
// content/prompts/ — it is shared with the verifier.
const judgeTemplatePath = `${import.meta.dirname}/judge.md`

export interface JudgmentPromptTemplates {
  readonly judge: string
  readonly stageScope: string
}

export const loadJudgmentPromptTemplates = Effect.fn(
  "gauntlet.judgment.load_prompt_templates",
)(function* () {
  const fs = yield* FileSystem.FileSystem
  const [judge, stageScope] = yield* Effect.all(
    [
      fs.readFileString(judgeTemplatePath).pipe(
        Effect.mapError((cause) =>
          new ContentLoadError({
            path: judgeTemplatePath,
            reason: "could not read prompt",
            cause,
          })),
      ),
      loadStageScopeTemplate(),
    ],
    { concurrency: 2 },
  )
  return { judge, stageScope } satisfies JudgmentPromptTemplates
})

export const assembleJudgmentPrompt = (
  templates: JudgmentPromptTemplates,
  target: ReviewTarget,
  reviewRoot: string,
  observations: ReadonlyArray<IndexedObservation>,
  specification: ReviewSpecification | undefined,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const scope = yield* assembleStageScope(
      templates.stageScope,
      target,
      reviewRoot,
      specification,
    )
    return yield* renderPromptTemplate("judge", templates.judge, [
      ["SCOPE_BLOCK", scope],
      ["CANDIDATES", Array.map(observations, formatCandidateLine).join("\n")],
    ])
  })
