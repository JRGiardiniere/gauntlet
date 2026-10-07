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
  renderWorkspaceTools,
} from "./prompt-template.ts"
import { renderSpecificationSection } from "./specification-section.ts"
import type { RelatedFiles } from "../workspace/related-files.ts"

export { PromptAssemblyError }

export const FINDER_TOOLS = ["read", "bash"] as const

export interface FinderPromptTemplates {
  readonly systemPrompt: string
  readonly sharedPromptTemplate: string
  readonly workspaceTools: string
}

export type ResolvedFinderContext =
  | {
      readonly key: "specific"
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
    : { key: "specific" }

const promptReader = Effect.fn("FinderPrompt.promptReader")(
  function* () {
    const root = yield* ContentDirectory
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return (name: string) => {
      const promptPath = path.join(root, "prompts", name)
      return fs.readFileString(promptPath).pipe(
        Effect.mapError((cause) =>
          new ContentLoadError({
            path: promptPath,
            reason: "could not read prompt",
            cause,
          })),
      )
    }
  },
)

export const loadFinderPromptTemplates = Effect.fn(
  "gauntlet.finder_prompt.load_templates",
)(function* (workspacePrompt: string) {
  const readPrompt = yield* promptReader()
  const [systemPrompt, sharedPromptTemplate, workspaceTools] = yield* Effect.all(
    [
      readPrompt("finder-system.md"),
      readPrompt("finder-shared-block.md"),
      readPrompt(workspacePrompt),
    ],
    { concurrency: 3 },
  )
  return {
    systemPrompt,
    sharedPromptTemplate,
    workspaceTools,
  } satisfies FinderPromptTemplates
})

// The shared block follows the finder system prompt inside the system prompt
// (provider `instructions`); the user message carries only the lens tail. An
// Interpretive Finder's ReviewSpecification follows the shared block —
// identical for every interpretive lens, so it is still shared prefix, not
// tail — and only the lens tail diverges, so multiple finder invocations can
// share a provider cache prefix without lens labels, run ids, or timestamps
// leaking ahead of it. A Specific Finder never receives specification
// material (issue #73).
export const assembleFinderContext = (
  templates: Omit<FinderPromptTemplates, "systemPrompt">,
  target: ReviewTarget,
  reviewRoot: string,
  context: ResolvedFinderContext,
): Effect.Effect<string, PromptAssemblyError> =>
  Effect.gen(function* () {
    const shared = yield* renderPromptTemplate(
      "finder shared-block",
      templates.sharedPromptTemplate,
      [
        ["REPO_ROOT", reviewRoot],
        [
          "WORKSPACE_TOOLS",
          yield* renderWorkspaceTools(templates.workspaceTools, reviewRoot),
        ],
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

// Read only for a ReviewPlan that froze the related-file context.
export const loadRelatedFilesTemplate = Effect.fn(
  "FinderPrompt.loadRelatedFilesTemplate",
)(function* () {
  return yield* (yield* promptReader())("finder-related-files.md")
})

const wholeFiles = (files: RelatedFiles["touched"]): string =>
  files.length === 0
    ? "(none)"
    : files.map(({ file, text }) =>
      `### ${file}\n\n${fenceMarkdownBlock("", text)}`
    ).join("\n\n")

// Appended to the shared block, so every Finder in a partition still shares
// one byte-identical system prompt.
export const renderRelatedFiles = (
  template: string,
  relatedFiles: RelatedFiles,
): Effect.Effect<string, PromptAssemblyError> =>
  renderPromptTemplate("finder related-files", template, [
    ["TOUCHED_FILES", wholeFiles(relatedFiles.touched)],
    ["RELATED_FILES", wholeFiles(relatedFiles.related)],
  ])

export const assembleFinderAssignment = (lens: FrozenLens): string => {
  const sections = ["## Your lens", lens.promptText]
    if (lens.candidateCap !== DEFAULT_CANDIDATE_CAP) {
      sections.push(
        `## Lens candidate cap\n\nThis lens may report at most ${String(lens.candidateCap)} findings. This overrides the shared limit of ${String(DEFAULT_CANDIDATE_CAP)}.`,
      )
    }
  return sections.join("\n\n")
}

export const assembleFinderPrompt = (
  templates: Omit<FinderPromptTemplates, "systemPrompt">,
  target: ReviewTarget,
  reviewRoot: string,
  lens: FrozenLens,
  specification: ReviewSpecification | undefined,
): Effect.Effect<string, PromptAssemblyError> =>
  assembleFinderContext(
    templates,
    target,
    reviewRoot,
    resolveFinderContext(lens, specification),
  ).pipe(
    Effect.map((context) =>
      `${context}\n\n${assembleFinderAssignment(lens)}`
    ),
  )
