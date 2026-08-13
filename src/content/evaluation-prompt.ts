import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HashMap from "effect/HashMap"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import type {
  IndexedBugClaim,
  NumberedPoolCluster,
} from "../assembly/pool.ts"
import type { ReviewTarget } from "../domain/review-target.ts"
import { formatCandidateLine } from "./candidate-line.ts"
import { ContentDirectory, ContentLoadError } from "./lens.ts"
import {
  fenceMarkdownBlock,
  type PromptAssemblyError,
  renderPromptTemplate,
} from "./prompt-template.ts"

export const POOL_TOOLS = [] as const
export const VERIFICATION_TOOLS = ["read", "bash"] as const

export const EVALUATION_SYSTEM_PROMPT =
  "You are a stage in a code-review pipeline. Follow the supplied stage instructions and finish by calling the required emit tool."

export interface EvaluationPromptTemplates {
  readonly pool: string
  readonly verifier: string
  readonly stageScope: string
}

const promptReader = Effect.fn(
  "gauntlet.evaluation_prompt.prompt_reader",
)(function* () {
  const root = yield* ContentDirectory
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const promptsDirectory = path.join(root, "prompts")
  return (name: string) => {
    const promptPath = path.join(promptsDirectory, name)
    return fs.readFileString(promptPath).pipe(
      Effect.mapError((cause) =>
        new ContentLoadError({
          path: promptPath,
          reason: "could not read prompt",
          cause,
        })),
    )
  }
})

export const loadEvaluationPromptTemplates = Effect.fn(
  "gauntlet.evaluation_prompt.load_templates",
)(function* () {
  const readPrompt = yield* promptReader()
  const [pool, verifier, stageScope] = yield* Effect.all(
    [
      readPrompt("pool.md"),
      readPrompt("verifier.md"),
      readPrompt("stage-scope-block.md"),
    ],
    { concurrency: 3 },
  )
  return { pool, verifier, stageScope } satisfies EvaluationPromptTemplates
})

// The scope block is shared by every candidate-evaluating stage; a Stage
// module that owns its main template still loads this one from content.
export const loadStageScopeTemplate = Effect.fn(
  "gauntlet.evaluation_prompt.load_stage_scope_template",
)(function* () {
  const readPrompt = yield* promptReader()
  return yield* readPrompt("stage-scope-block.md")
})

export const assemblePoolPrompt = (
  template: string,
  claims: ReadonlyArray<IndexedBugClaim>,
): Effect.Effect<string, PromptAssemblyError> =>
  renderPromptTemplate("pool", template, [
    ["CANDIDATES", Array.map(claims, formatCandidateLine).join("\n")],
  ])

const verifierClaims = (
  bundle: ReadonlyArray<NumberedPoolCluster>,
  claims: ReadonlyArray<IndexedBugClaim>,
): string => {
  const byIndex = HashMap.fromIterable(
    Array.map(claims, (claim) => [claim.index, claim] as const),
  )
  return Array.map(bundle, (cluster) => {
    const members = Array.filterMap(cluster.indexes, (index) =>
      HashMap.get(byIndex, index).pipe(
        Result.fromOption(() => undefined),
      )).map((claim) =>
        formatCandidateLine(claim).split("\n").map((line) => `  ${line}`).join("\n")
      ).join("\n")
    return `### [c${String(cluster.number)}] ${cluster.summary}\n${members}`
  }).join("\n\n")
}

export const assembleStageScope = (
  template: string,
  target: ReviewTarget,
  reviewRoot: string,
): Effect.Effect<string, PromptAssemblyError> =>
  renderPromptTemplate("stage scope", template, [
    ["REPO_ROOT", reviewRoot],
    [
      "CHANGED_FILES",
      Array.map(target.changedFiles, (file) => `- ${file}`).join("\n"),
    ],
    [
      "DIFF_SECTION",
      `## Diff under review\n\n${fenceMarkdownBlock("diff", target.diff)}`,
    ],
  ])

export const assembleVerifierPrompt = (
  templates: EvaluationPromptTemplates,
  target: ReviewTarget,
  reviewRoot: string,
  claims: ReadonlyArray<IndexedBugClaim>,
  bundle: ReadonlyArray<NumberedPoolCluster>,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const scope = yield* assembleStageScope(
      templates.stageScope,
      target,
      reviewRoot,
    )
    return yield* renderPromptTemplate("verifier", templates.verifier, [
      ["SCOPE_BLOCK", scope],
      ["CLAIMS", verifierClaims(bundle, claims)],
    ])
  })
