import { Dossier } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { targetIdentityOf } from "../domain/review-target.ts"

interface AssembledPath {
  readonly coverageGaps: Dossier["coverageGaps"]
}

interface AssembledBugClaimPath extends AssembledPath {
  readonly bugClaims: Dossier["bugClaims"]
}

interface AssembledJudgmentPath extends AssembledPath {
  readonly observations: Dossier["observations"]
}

export interface DossierAssembly {
  readonly plan: ReviewPlan
  readonly finderCoverageGaps: Dossier["coverageGaps"]
  readonly bugClaimPath: AssembledBugClaimPath
  readonly judgmentPath: AssembledJudgmentPath
}

// Assembly is the single deterministic join of the two model-backed paths.
// Presentation consumes this Dossier and never invokes a model.
export const assembleDossier = ({
  bugClaimPath,
  finderCoverageGaps,
  judgmentPath,
  plan,
}: DossierAssembly): Dossier =>
  Dossier.make({
    runId: plan.runId,
    target: targetIdentityOf(plan.target),
    bugClaims: bugClaimPath.bugClaims,
    observations: judgmentPath.observations,
    coverageGaps: [
      ...finderCoverageGaps,
      ...bugClaimPath.coverageGaps,
      ...judgmentPath.coverageGaps,
    ],
  })
