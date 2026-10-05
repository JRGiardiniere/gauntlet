import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { formatCandidateLine } from "../../content/candidate-line.ts"
import {
  assembleStageScope,
  loadStageScopeTemplates,
  type StageScopeTemplates,
} from "../../content/evaluation-prompt.ts"
import { ContentLoadError, isCompiledBinary } from "../../content/lens.ts"
import {
  type PromptAssemblyError,
  renderPromptTemplate,
} from "../../content/prompt-template.ts"
import type { ReviewSpecification } from "../../domain/review-specification.ts"
import type { ReviewTarget } from "../../domain/review-target.ts"
import type { PooledBugClaims } from "../../run/bug-claim-path.ts"
import type { IndexedObservation } from "./resolution.ts"

// The judge template ships with this Stage module, so stage tests exercise
// the same prompt text a real run pays for. The scope block stays in
// content/prompts/ — it is shared with the verifier. A compiled binary
// embeds the file at its repo-relative path under the bundle root, where
// every module's own dirname collapses to.
const templatePath = (name: string) =>
  isCompiledBinary
    ? `${import.meta.dirname}/src/stages/judgment/${name}`
    : `${import.meta.dirname}/${name}`

export interface JudgmentPromptTemplates extends StageScopeTemplates {
  readonly judge: string
  readonly bugClaimClusters: string
}

export const loadJudgmentPromptTemplates = Effect.fn(
  "gauntlet.judgment.load_prompt_templates",
)(function* (workspacePrompt: string) {
  const fs = yield* FileSystem.FileSystem
  const readTemplate = (name: string) =>
    fs.readFileString(templatePath(name)).pipe(
      Effect.mapError((cause) =>
        new ContentLoadError({
          path: templatePath(name),
          reason: "could not read prompt",
          cause,
        })),
    )
  const [judge, bugClaimClusters, scope] = yield* Effect.all(
    [
      readTemplate("judge.md"),
      readTemplate("bug-claim-clusters.md"),
      loadStageScopeTemplates(workspacePrompt),
    ],
    { concurrency: 3 },
  )
  return { judge, bugClaimClusters, ...scope } satisfies JudgmentPromptTemplates
})

export const assembleJudgmentPrompt = (
  templates: JudgmentPromptTemplates,
  target: ReviewTarget,
  reviewRoot: string,
  observations: ReadonlyArray<IndexedObservation>,
  specification: ReviewSpecification | undefined,
  pooled: Pick<PooledBugClaims, "claims" | "clusters">,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const scope = yield* assembleStageScope(
      templates,
      target,
      reviewRoot,
      specification,
    )
    // A run with no BugClaims carries no cluster block at all.
    const clusters = pooled.clusters.length === 0
      ? ""
      : `\n\n${yield* renderPromptTemplate(
        "judge bug-claim clusters",
        templates.bugClaimClusters,
        [["CLUSTERS", clusterLines(pooled)]],
      )}`
    return yield* renderPromptTemplate("judge", templates.judge, [
      ["SCOPE_BLOCK", scope],
      ["BUG_CLAIM_CLUSTERS", clusters],
      ["CANDIDATES", Array.map(observations, formatCandidateLine).join("\n")],
    ])
  })

// One line per cluster, located at its first BugClaim, in Pool's numbering.
const clusterLines = (
  { claims, clusters }: Pick<PooledBugClaims, "claims" | "clusters">,
): string =>
  clusters.map(({ indexes, number, summary }) => {
    const first = claims.find(({ index }) => index === indexes[0])?.candidate
    const location = first === undefined
      ? ""
      : `${first.file}${first.line === undefined ? "" : `:${String(first.line)}`} — `
    return `- [c${String(number)}] ${location}${summary}`
  }).join("\n")
