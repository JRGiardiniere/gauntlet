import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import {
  DEFAULT_CANDIDATE_CAP,
  type FrozenLens,
} from "../domain/review-plan.ts"
import type { ReviewTarget } from "../domain/review-target.ts"
import { ContentDirectory, ContentLoadError } from "./lens.ts"
import {
  fenceMarkdownBlock,
  PromptAssemblyError,
  renderPromptTemplate,
} from "./prompt-template.ts"

export { PromptAssemblyError }

export const FINDER_TOOLS = ["read", "bash"] as const

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
  reviewRoot: string,
  lens: FrozenLens,
  specText?: string,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const shared = yield* renderPromptTemplate(
      "finder shared-block",
      template,
      [
        ["REPO_ROOT", reviewRoot],
        [
          "CHANGED_FILES",
          target.changedFiles.map((file) => `- ${file}`).join("\n"),
        ],
        [
          "DIFF_SECTION",
          `## Diff\n\n${fenceMarkdownBlock("diff", target.diff)}`,
        ],
        ["MAX_PER_LENS", String(DEFAULT_CANDIDATE_CAP)],
      ],
    )
    const lensSections = [lens.promptText]
    if (lens.candidateCap !== DEFAULT_CANDIDATE_CAP) {
      lensSections.push(
        `## Lens candidate cap\n\nThis lens may report at most ${String(lens.candidateCap)} findings. This overrides the shared limit of ${String(DEFAULT_CANDIDATE_CAP)}.`,
      )
    }
    if (lens.needsSpec) {
      if (specText === undefined) {
        return yield* new PromptAssemblyError({
          reason: `lens ${lens.name} needs spec text but none is frozen in the review plan`,
        })
      }
      lensSections.push(`## Originating spec\n\n${specText}`)
    }
    return `${shared}\n\n${lensSections.join("\n\n")}`
  })
