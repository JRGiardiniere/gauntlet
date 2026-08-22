import {
  Dossier,
  DossierFinding,
  DossierUnresolved,
  DroppedObservation,
  type CoverageGap,
  type EvaluatedBugClaim,
  type JudgedObservation,
  RefutedClaim,
  type TestSuggestion,
} from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { targetIdentityOf } from "../domain/review-target.ts"
import { Verdict, type ReviewPriority } from "../domain/verdict.ts"
import { clusterEvaluatedBugClaims } from "./bug-claim-cluster.ts"

interface AssembledPath {
  readonly coverageGaps: ReadonlyArray<CoverageGap>
}

interface AssembledBugClaimPath extends AssembledPath {
  readonly bugClaims: ReadonlyArray<EvaluatedBugClaim>
  readonly testSuggestions: ReadonlyArray<TestSuggestion>
}

interface AssembledJudgmentPath extends AssembledPath {
  readonly observations: ReadonlyArray<JudgedObservation>
}

export interface DossierAssembly {
  readonly plan: ReviewPlan
  readonly finderCoverageGaps: ReadonlyArray<CoverageGap>
  readonly bugClaimPath: AssembledBugClaimPath
  readonly judgmentPath: AssembledJudgmentPath
}

const suggestionFor = (
  bugClaimIds: ReadonlySet<string>,
  testSuggestions: ReadonlyArray<TestSuggestion>,
): TestSuggestion | undefined =>
  testSuggestions.find(({ bugClaimIds: suggestedIds }) =>
    suggestedIds.some((id) => bugClaimIds.has(id))
  )

const priorityRank = {
  P1: 0,
  P2: 1,
  P3: 2,
} satisfies Record<ReviewPriority, number>

const orderFindings = (
  findings: Array<DossierFinding>,
): ReadonlyArray<DossierFinding> =>
  findings.sort((left, right) => {
    const leftPriority = DossierFinding.match(left, {
      Confirmed: ({ verdict }) => verdict.reviewPriority,
      Judgment: ({ judgment }) => judgment.reviewPriority,
    })
    const rightPriority = DossierFinding.match(right, {
      Confirmed: ({ verdict }) => verdict.reviewPriority,
      Judgment: ({ judgment }) => judgment.reviewPriority,
    })
    const priorityDifference =
      priorityRank[leftPriority] - priorityRank[rightPriority]
    if (priorityDifference !== 0) return priorityDifference
    if (left._tag === right._tag) return 0
    return DossierFinding.guards.Confirmed(left) ? -1 : 1
  })

// Assembly is the single deterministic join of the two model-backed paths.
// It writes the same hierarchy consumed by both report renderers.
export const assembleDossier = ({
  bugClaimPath,
  finderCoverageGaps,
  judgmentPath,
  plan,
}: DossierAssembly): Dossier => {
  const findings: Array<DossierFinding> = []
  const unresolved: Array<DossierUnresolved> = []
  const refutedClaims: Array<RefutedClaim> = []
  const droppedObservations: Array<DroppedObservation> = []

  for (const { bugClaims, cluster, verdict } of clusterEvaluatedBugClaims(
    bugClaimPath.bugClaims,
  )) {
    const clusterCore = { bugClaims, cluster }
    const testSuggestion = suggestionFor(
      new Set(bugClaims.map(({ id }) => id)),
      bugClaimPath.testSuggestions,
    )
    const suggestedCore = testSuggestion === undefined
      ? clusterCore
      : { ...clusterCore, testSuggestion }
    if (Verdict.guards.Confirmed(verdict)) {
      findings.push(
        DossierFinding.cases.Confirmed.make({ ...suggestedCore, verdict }),
      )
    } else if (Verdict.guards.Plausible(verdict)) {
      unresolved.push(
        DossierUnresolved.cases.Plausible.make({ ...suggestedCore, verdict }),
      )
    } else {
      refutedClaims.push(RefutedClaim.make({ ...clusterCore, verdict }))
    }
  }

  for (const { candidate, judgment } of judgmentPath.observations) {
    if (Judgment.guards.Kept(judgment)) {
      findings.push(
        DossierFinding.cases.Judgment.make({ candidate, judgment }),
      )
    } else if (Judgment.guards.Undecided(judgment)) {
      unresolved.push(
        DossierUnresolved.cases.Undecided.make({ candidate, judgment }),
      )
    } else {
      droppedObservations.push(
        DroppedObservation.make({ candidate, judgment }),
      )
    }
  }

  return Dossier.make({
    runId: plan.runId,
    target: targetIdentityOf(plan.target),
    findings: orderFindings(findings),
    unresolved,
    rejected: { refutedClaims, droppedObservations },
    coverageGaps: [
      ...finderCoverageGaps,
      ...bugClaimPath.coverageGaps,
      ...judgmentPath.coverageGaps,
    ],
  })
}
