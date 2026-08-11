import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import type { FrozenLens } from "../domain/review-plan.ts"
import type { ReviewTarget } from "../domain/review-target.ts"

export const FINDER_TOOLS = ["read", "bash"] as const
export const DEFAULT_CANDIDATE_CAP = 6

export class PromptAssemblyError extends Data.TaggedError(
  "PromptAssemblyError",
)<{ readonly reason: string }> {}

const substitute = (
  template: string,
  placeholder: string,
  value: string,
): string => template.replaceAll(`{{${placeholder}}}`, value)

// The shared block is always the first byte of the user prompt. Only the lens
// tail diverges, so multiple finder invocations can share a provider cache
// prefix without lens labels, run ids, or timestamps leaking ahead of it.
export const assembleFinderPrompt = (
  template: string,
  target: ReviewTarget,
  lens: FrozenLens,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const substitutions = [
      ["REPO_ROOT", target.repoRoot],
      [
        "CHANGED_FILES",
        target.changedFiles.map((file) => `- ${file}`).join("\n"),
      ],
      ["DIFF", target.diff],
      ["MAX_PER_LENS", String(lens.candidateCap)],
    ] as const
    const admitted: ReadonlySet<string> = new Set(
      substitutions.map(([placeholder]) => placeholder),
    )
    const declared = [...template.matchAll(/\{\{([A-Z_]+)\}\}/g)].map(
      (match) => match[1] ?? "",
    )
    const invalid = declared.find((placeholder) => !admitted.has(placeholder))
    const missing = substitutions.find(
      ([placeholder]) => !declared.includes(placeholder),
    )
    if (invalid !== undefined || missing !== undefined) {
      return yield* new PromptAssemblyError({
        reason: invalid === undefined
          ? `finder shared-block template is missing {{${missing?.[0] ?? ""}}}`
          : `finder shared-block template contains unresolved {{${invalid}}}`,
      })
    }

    const shared = substitutions.reduce(
      (text, [placeholder, value]) => substitute(text, placeholder, value),
      template,
    )
    return `${shared.trimEnd()}\n\n${lens.promptText}`
  })
