import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import type {
  IndexedBugClaim,
  NumberedPoolCluster,
} from "../assembly/pool.ts"
import type { ReviewTarget } from "../domain/review-target.ts"
import { PromptAssemblyError } from "./finder-prompt.ts"
import { ContentDirectory, ContentLoadError } from "./lens.ts"

export const POOL_TOOLS = [] as const
export const VERIFICATION_TOOLS = ["read", "bash"] as const

export const EVALUATION_SYSTEM_PROMPT =
  "You are a stage in a code-review pipeline. Follow the supplied stage instructions and finish by calling the required emit tool."

export interface EvaluationPromptTemplates {
  readonly pool: string
  readonly verifier: string
  readonly stageScope: string
}

export const loadEvaluationPromptTemplates = Effect.fn(
  "gauntlet.evaluation_prompt.load_templates",
)(function* () {
  const root = yield* ContentDirectory
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const promptsDirectory = path.join(root, "prompts")
  const readPrompt = (name: string) => {
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

const renderTemplate = (
  name: string,
  template: string,
  substitutions: ReadonlyArray<readonly [string, string]>,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const values = HashMap.fromIterable(substitutions)
    let missing = HashSet.fromIterable(HashMap.keys(values))
    const parts: Array<string> = []
    let cursor = 0

    for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const token = match[0]
      const placeholder = token.slice(2, -2)
      const value = HashMap.get(values, placeholder)
      if (Option.isNone(value)) {
        return yield* new PromptAssemblyError({
          reason: `${name} template contains unresolved {{${placeholder}}}`,
        })
      }
      parts.push(template.slice(cursor, match.index), value.value)
      cursor = match.index + token.length
      missing = HashSet.remove(missing, placeholder)
    }
    const missingPlaceholder = Array.fromIterable(missing)[0]
    if (missingPlaceholder !== undefined) {
      return yield* new PromptAssemblyError({
        reason: `${name} template is missing {{${missingPlaceholder}}}`,
      })
    }
    parts.push(template.slice(cursor))
    return parts.join("").trimEnd()
  })

const candidateLine = ({ candidate, index }: IndexedBugClaim): string => {
  const location = `${candidate.file}${candidate.line === undefined ? "" : `:${String(candidate.line)}`}`
  return [
    `[${String(index)}] (${candidate.lens}) ${location} — ${candidate.summary}`,
    `    claimed failure: ${candidate.failureScenario}`,
  ].join("\n")
}

export const assemblePoolPrompt = (
  template: string,
  claims: ReadonlyArray<IndexedBugClaim>,
): Effect.Effect<string, PromptAssemblyError> =>
  renderTemplate("pool", template, [
    ["CANDIDATES", Array.map(claims, candidateLine).join("\n")],
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
        candidateLine(claim).split("\n").map((line) => `  ${line}`).join("\n")
      ).join("\n")
    return `### [c${String(cluster.number)}] ${cluster.summary}\n${members}`
  }).join("\n\n")
}

export const assembleVerifierPrompt = (
  templates: EvaluationPromptTemplates,
  target: ReviewTarget,
  specText: string | undefined,
  claims: ReadonlyArray<IndexedBugClaim>,
  bundle: ReadonlyArray<NumberedPoolCluster>,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const scope = yield* renderTemplate("stage scope", templates.stageScope, [
      ["REPO_ROOT", target.repoRoot],
      [
        "CHANGED_FILES",
        Array.map(target.changedFiles, (file) => `- ${file}`).join("\n"),
      ],
      ["DIFF_SECTION", `## Diff under review\n\n\`\`\`diff\n${target.diff}\n\`\`\``],
      ["INTENT_SECTION", specText ?? "No originating spec was provided."],
    ])
    return yield* renderTemplate("verifier", templates.verifier, [
      ["SCOPE_BLOCK", scope],
      ["CLAIMS", verifierClaims(bundle, claims)],
    ])
  })
