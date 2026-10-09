import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import { ContentDirectory, isCompiledBinary } from "../content/lens.ts"
import {
  fenceMarkdownBlock,
  type PromptAssemblyError,
  readPromptTemplate,
  renderPromptTemplate,
  renderWorkspaceTools,
} from "../content/prompt-template.ts"
import { renderSpecificationSection } from "../content/specification-section.ts"
import type { ReviewSpecification } from "../domain/review-specification.ts"
import type { ReviewTarget } from "../domain/review-target.ts"

// The scope block Verification and Judgment both open with. It ships with
// the Stage modules; the Host's workspace wording it carries stays in
// content/prompts/.
const templatePath = isCompiledBinary
  ? `${import.meta.dirname}/src/stages/stage-scope-block.md`
  : `${import.meta.dirname}/stage-scope-block.md`

export interface StageScopeTemplates {
  readonly stageScope: string
  readonly workspaceTools: string
}

export const loadStageScopeTemplates = Effect.fn("StageScope.loadTemplates")(
  function* (workspacePrompt: string) {
    const path = yield* Path.Path
    const workspacePromptPath = path.join(
      yield* ContentDirectory,
      "prompts",
      workspacePrompt,
    )
    const [stageScope, workspaceTools] = yield* Effect.all(
      [readPromptTemplate(templatePath), readPromptTemplate(workspacePromptPath)],
      { concurrency: 2 },
    )
    return { stageScope, workspaceTools } satisfies StageScopeTemplates
  },
)

// The frozen ReviewSpecification, when one exists, follows the stable scope
// and comes before the Stage's assignment (issue #73). Pool never gets one.
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
