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
import type { ReviewSpecification } from "../domain/review-specification.ts"
import type { ReviewTarget } from "../domain/review-target.ts"
import { formatCandidateLine } from "./candidate-line.ts"
import { ContentDirectory, ContentLoadError } from "./lens.ts"
import {
  fenceMarkdownBlock,
  type PromptAssemblyError,
  renderPromptTemplate,
  renderWorkspaceTools,
} from "./prompt-template.ts"
import { renderSpecificationSection } from "./specification-section.ts"

export const POOL_TOOLS = [] as const
export const VERIFICATION_TOOLS = ["read", "bash"] as const

export const EVALUATION_SYSTEM_PROMPT =
  "You are a stage in a code-review pipeline. Follow the supplied stage instructions and finish by calling the required emit tool."

// The scope block and the host's workspace wording it carries.
export interface StageScopeTemplates {
  readonly stageScope: string
  readonly workspaceTools: string
}

export interface EvaluationPromptTemplates extends StageScopeTemplates {
  readonly pool: string
  readonly verifier: string
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
)(function* (workspacePrompt: string) {
  const readPrompt = yield* promptReader()
  const [pool, verifier, scope] = yield* Effect.all(
    [
      readPrompt("pool.md"),
      readPrompt("verifier.md"),
      loadStageScopeTemplates(workspacePrompt),
    ],
    { concurrency: 3 },
  )
  return { pool, verifier, ...scope } satisfies EvaluationPromptTemplates
})

// The scope block is shared by every candidate-evaluating stage; a Stage
// module that owns its main template still loads this one from content.
export const loadStageScopeTemplates = Effect.fn(
  "EvaluationPrompt.loadStageScopeTemplates",
)(function* (workspacePrompt: string) {
  const readPrompt = yield* promptReader()
  const [stageScope, workspaceTools] = yield* Effect.all(
    [readPrompt("stage-scope-block.md"), readPrompt(workspacePrompt)],
    { concurrency: 2 },
  )
  return { stageScope, workspaceTools } satisfies StageScopeTemplates
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

// Verification and Judgment both receive the frozen ReviewSpecification when
// one exists, appended after the stable scope and before their assignment
// (issue #73). Pool never does — assemblePoolPrompt stays candidate-only.
export const assembleStageScope = (
  templates: StageScopeTemplates,
  target: ReviewTarget,
  reviewRoot: string,
  specification: ReviewSpecification | undefined,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const scope = yield* renderPromptTemplate("stage scope", templates.stageScope, [
      ["REPO_ROOT", reviewRoot],
      [
        "WORKSPACE_TOOLS",
        yield* renderWorkspaceTools(templates.workspaceTools, reviewRoot),
      ],
      [
        "CHANGED_FILES",
        Array.map(target.changedFiles, (file) => `- ${file}`).join("\n"),
      ],
      [
        "DIFF_SECTION",
        `## Diff under review\n\n${fenceMarkdownBlock("diff", target.diff)}`,
      ],
    ])
    return specification === undefined
      ? scope
      : `${scope}\n\n${renderSpecificationSection(specification)}`
  })

export const assembleVerifierPrompt = (
  templates: EvaluationPromptTemplates,
  target: ReviewTarget,
  reviewRoot: string,
  claims: ReadonlyArray<IndexedBugClaim>,
  bundle: ReadonlyArray<NumberedPoolCluster>,
  specification: ReviewSpecification | undefined,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const scope = yield* assembleStageScope(
      templates,
      target,
      reviewRoot,
      specification,
    )
    return yield* renderPromptTemplate("verifier", templates.verifier, [
      ["SCOPE_BLOCK", scope],
      ["CLAIMS", verifierClaims(bundle, claims)],
    ])
  })
