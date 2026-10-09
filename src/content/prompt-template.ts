import * as Array from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import { ContentLoadError } from "./lens.ts"

export class PromptAssemblyError extends Data.TaggedError(
  "PromptAssemblyError",
)<{ readonly reason: string }> {}

export const readPromptTemplate = Effect.fn("PromptTemplate.read")(function* (
  path: string,
) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.mapError((cause) =>
      new ContentLoadError({ path, reason: "could not read prompt", cause })),
  )
})

export const renderPromptTemplate = Effect.fn(
  "gauntlet.prompt_template.render",
)(function* (
  name: string,
  template: string,
  substitutions: ReadonlyArray<readonly [string, string]>,
) {
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

// The host's own tool wording, filled into a template's {{WORKSPACE_TOOLS}}.
export const renderWorkspaceTools = (
  template: string,
  reviewRoot: string,
): Effect.Effect<string, PromptAssemblyError> =>
  renderPromptTemplate("workspace tools", template, [
    ["REPO_ROOT", reviewRoot],
  ])

export const fenceMarkdownBlock = (language: string, content: string): string => {
  const longestBacktickRun = Array.reduce(
    Array.fromIterable(content.matchAll(/`+/g)),
    2,
    (longest, match) => Math.max(longest, match[0].length),
  )
  const fence = "`".repeat(longestBacktickRun + 1)
  return `${fence}${language}\n${content}\n${fence}`
}
