import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Result from "effect/Result"
import { formatCandidateLine } from "../../content/candidate-line.ts"
import { isCompiledBinary } from "../../content/lens.ts"
import {
  type PromptAssemblyError,
  readPromptTemplate,
  renderPromptTemplate,
} from "../../content/prompt-template.ts"
import type { ReviewSpecification } from "../../domain/review-specification.ts"
import type { ReviewTarget } from "../../domain/review-target.ts"
import type {
  IndexedBugClaim,
  NumberedPoolCluster,
} from "../pool/pool.ts"
import {
  assembleStageScope,
  loadStageScopeTemplates,
  type StageScopeTemplates,
} from "../scope.ts"

// Compiled, the binary embeds the template at its repo-relative path under
// the bundle root (see stages/judgment/prompt.ts).
const templatePath = isCompiledBinary
  ? `${import.meta.dirname}/src/stages/verification/verifier.md`
  : `${import.meta.dirname}/verifier.md`

export interface VerifierPromptTemplates extends StageScopeTemplates {
  readonly verifier: string
}

export const loadVerifierPromptTemplates = Effect.fn(
  "Verification.loadPromptTemplates",
)(function* (workspacePrompt: string) {
  const [verifier, scope] = yield* Effect.all(
    [readPromptTemplate(templatePath), loadStageScopeTemplates(workspacePrompt)],
    { concurrency: 2 },
  )
  return { verifier, ...scope } satisfies VerifierPromptTemplates
})

// Each cluster under its [cN] label, its member BugClaims indented below in
// Pool's order.
const verifierClaims = (
  bundle: ReadonlyArray<NumberedPoolCluster>,
  claims: ReadonlyArray<IndexedBugClaim>,
): string => {
  const byIndex = HashMap.fromIterable(
    Array.map(claims, (claim) => [claim.index, claim] as const),
  )
  return bundle.map((cluster) => {
    const members = Array.filterMap(cluster.indexes, (index) =>
      Result.fromOption(HashMap.get(byIndex, index), () => undefined))
      .map((claim) =>
        formatCandidateLine(claim).split("\n").map((line) => `  ${line}`).join("\n")
      )
      .join("\n")
    return `### [c${String(cluster.number)}] ${cluster.summary}\n${members}`
  }).join("\n\n")
}

export const assembleVerifierPrompt = (
  templates: VerifierPromptTemplates,
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
