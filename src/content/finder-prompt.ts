import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import {
  DEFAULT_CANDIDATE_CAP,
  type FrozenLens,
} from "../domain/review-plan.ts"
import type { ReviewSpecification } from "../domain/review-specification.ts"
import type { ReviewTarget } from "../domain/review-target.ts"
import { ContentDirectory, ContentLoadError } from "./lens.ts"
import {
  fenceMarkdownBlock,
  PromptAssemblyError,
  renderPromptTemplate,
} from "./prompt-template.ts"
import { renderSpecificationSection } from "./specification-section.ts"

export { PromptAssemblyError }

export const FINDER_TOOLS = ["read", "bash"] as const

export interface FinderPromptTemplates {
  readonly systemPrompt: string
  readonly sharedPromptTemplate: string
}

export type ResolvedFinderContext =
  | {
      readonly key: "standard"
      readonly specification?: undefined
    }
  | {
      readonly key: "interpretive-with-review-specification"
      readonly specification: ReviewSpecification
    }

// One decision owns both cache partition identity and rendered context. A new
// context variant cannot affect one without being represented in the other.
export const resolveFinderContext = (
  lens: FrozenLens,
  specification: ReviewSpecification | undefined,
): ResolvedFinderContext =>
  lens.finderClass === "interpretive" && specification !== undefined
    ? {
        key: "interpretive-with-review-specification",
        specification,
      }
    : { key: "standard" }

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

// The shared block is always the first byte of the user prompt. An
// Interpretive Finder's ReviewSpecification follows it — identical for every
// interpretive lens, so it is still shared prefix, not tail — and only the
// lens tail diverges, so multiple finder invocations can share a provider
// cache prefix without lens labels, run ids, or timestamps leaking ahead of
// it. A Standard Finder never receives specification material (issue #73).
export const assembleFinderContext = (
  template: string,
  target: ReviewTarget,
  reviewRoot: string,
  context: ResolvedFinderContext,
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
    const sections = [shared]
    if (context.specification !== undefined) {
      sections.push(renderSpecificationSection(context.specification))
    }
    return sections.join("\n\n")
  })

export const assembleFinderAssignment = (lens: FrozenLens): string => {
  const sections = [lens.promptText]
    if (lens.candidateCap !== DEFAULT_CANDIDATE_CAP) {
      sections.push(
        `## Lens candidate cap\n\nThis lens may report at most ${String(lens.candidateCap)} findings. This overrides the shared limit of ${String(DEFAULT_CANDIDATE_CAP)}.`,
      )
    }
  return sections.join("\n\n")
}

export const assembleFinderPrompt = (
  template: string,
  target: ReviewTarget,
  reviewRoot: string,
  lens: FrozenLens,
  specification: ReviewSpecification | undefined,
): Effect.Effect<string, PromptAssemblyError> =>
  assembleFinderContext(
    template,
    target,
    reviewRoot,
    resolveFinderContext(lens, specification),
  ).pipe(
    Effect.map((context) =>
      `${context}\n\n${assembleFinderAssignment(lens)}`
    ),
  )
