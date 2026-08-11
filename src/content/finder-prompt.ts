import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type { FrozenLens } from "../domain/review-plan.ts"
import type { ReviewTarget } from "../domain/review-target.ts"
import { ContentDirectory, ContentLoadError } from "./lens.ts"

export const FINDER_TOOLS = ["read", "bash"] as const
export const DEFAULT_CANDIDATE_CAP = 6

export class PromptAssemblyError extends Data.TaggedError(
  "PromptAssemblyError",
)<{ readonly reason: string }> {}

export interface FinderPromptTemplates {
  readonly systemPrompt: string
  readonly sharedPromptTemplate: string
}

export const loadFinderPromptTemplates = Effect.fn(
  "gauntlet.finder_prompt.load_templates",
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

  const [systemPrompt, sharedPromptTemplate] = yield* Effect.all(
    [readPrompt("finder-system.md"), readPrompt("finder-shared-block.md")],
    { concurrency: 2 },
  )
  return { systemPrompt, sharedPromptTemplate } satisfies FinderPromptTemplates
})

// The shared block is always the first byte of the user prompt. Only the lens
// tail diverges, so multiple finder invocations can share a provider cache
// prefix without lens labels, run ids, or timestamps leaking ahead of it.
export const assembleFinderPrompt = (
  template: string,
  target: ReviewTarget,
  lens: FrozenLens,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const substitutions = new Map<string, string>([
      ["REPO_ROOT", target.repoRoot],
      [
        "CHANGED_FILES",
        target.changedFiles.map((file) => `- ${file}`).join("\n"),
      ],
      ["DIFF", target.diff],
      ["MAX_PER_LENS", String(lens.candidateCap)],
    ])
    const missing = new Set(substitutions.keys())
    const parts: Array<string> = []
    let cursor = 0

    for (const match of template.matchAll(/\{\{([^{}]+)\}\}/g)) {
      const token = match[0]
      const placeholder = token.slice(2, -2)
      const value = substitutions.get(placeholder)
      if (value === undefined) {
        return yield* new PromptAssemblyError({
          reason:
            `finder shared-block template contains unresolved {{${placeholder}}}`,
        })
      }
      parts.push(template.slice(cursor, match.index), value)
      cursor = match.index + token.length
      missing.delete(placeholder)
    }
    for (const placeholder of missing) {
      return yield* new PromptAssemblyError({
        reason: `finder shared-block template is missing {{${placeholder}}}`,
      })
    }
    parts.push(template.slice(cursor))
    const shared = parts.join("")
    return `${shared.trimEnd()}\n\n${lens.promptText}`
  })
