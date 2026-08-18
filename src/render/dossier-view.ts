import {
  type BugClaimCluster,
  clusterEvaluatedBugClaims,
  projectBugClaimCluster,
} from "../assembly/bug-claim-cluster.ts"
import type { BugClaim, Candidate, Observation } from "../domain/candidate.ts"
import {
  DossierFinding,
  DossierUnresolved,
  type Dossier,
  type EvaluatedBugClaim,
  type JudgedObservation,
  type TestSuggestion,
} from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { Verdict, type ReviewPriority } from "../domain/verdict.ts"

export interface ConfirmedClaim {
  readonly candidate: BugClaim
  readonly lenses: ReadonlyArray<string>
  readonly verdict: typeof Verdict.cases.Confirmed.Type
}
export interface UnverifiedClaim {
  readonly candidate: BugClaim
  readonly lenses: ReadonlyArray<string>
  readonly verdict: typeof Verdict.cases.Unverified.Type
}
export interface RefutedClaim {
  readonly candidate: BugClaim
  readonly lenses: ReadonlyArray<string>
  readonly verdict: typeof Verdict.cases.Refuted.Type
}
export interface KeptObservation {
  readonly candidate: Observation
  readonly judgment: typeof Judgment.cases.Kept.Type
}
export interface DroppedObservation {
  readonly candidate: Observation
  readonly judgment: typeof Judgment.cases.Dropped.Type
}

export interface EvaluationView {
  readonly confirmed: ReadonlyArray<ConfirmedClaim>
  readonly unverified: ReadonlyArray<UnverifiedClaim>
  readonly refuted: ReadonlyArray<RefutedClaim>
  readonly kept: ReadonlyArray<KeptObservation>
  readonly undecided: ReadonlyArray<Observation>
  readonly dropped: ReadonlyArray<DroppedObservation>
}

export const viewBugClaims = (
  bugClaims: ReadonlyArray<EvaluatedBugClaim>,
): Pick<EvaluationView, "confirmed" | "unverified" | "refuted"> => {
  const clustered = clusterEvaluatedBugClaims(bugClaims)
  return {
    confirmed: clustered.flatMap(({ candidate, lenses, verdict }) =>
      Verdict.guards.Confirmed(verdict) ? [{ candidate, lenses, verdict }] : []
    ),
    unverified: clustered.flatMap(({ candidate, lenses, verdict }) =>
      Verdict.guards.Unverified(verdict) ? [{ candidate, lenses, verdict }] : []
    ),
    refuted: clustered.flatMap(({ candidate, lenses, verdict }) =>
      Verdict.guards.Refuted(verdict) ? [{ candidate, lenses, verdict }] : []
    ),
  }
}

export const viewObservations = (
  observations: ReadonlyArray<JudgedObservation>,
): Pick<EvaluationView, "kept" | "undecided" | "dropped"> => ({
  kept: observations.flatMap(({ candidate, judgment }) =>
    Judgment.guards.Kept(judgment) ? [{ candidate, judgment }] : []
  ),
  undecided: observations.flatMap(({ candidate, judgment }) =>
    Judgment.guards.Undecided(judgment) ? [candidate] : []
  ),
  dropped: observations.flatMap(({ candidate, judgment }) =>
    Judgment.guards.Dropped(judgment) ? [{ candidate, judgment }] : []
  ),
})

export type DossierEntryTag =
  | "confirmed"
  | "judgment"
  | "unverified"
  | "undecided"
  | "refuted"
  | "dropped"

export interface DossierEntryView {
  readonly candidate: Candidate
  readonly lenses: ReadonlyArray<string>
  readonly tag: DossierEntryTag
  readonly reviewPriority?: ReviewPriority
  readonly detail?: string
  readonly testSuggestion?: TestSuggestion
}

export interface DossierView {
  readonly findings: ReadonlyArray<DossierEntryView>
  readonly unresolved: ReadonlyArray<DossierEntryView>
  readonly refutedClaims: ReadonlyArray<DossierEntryView>
  readonly droppedObservations: ReadonlyArray<DossierEntryView>
}

const claimEntry = (
  entry: {
    readonly bugClaims: BugClaimCluster
    readonly testSuggestion?: TestSuggestion
  },
  tag: "confirmed" | "unverified" | "refuted",
  reviewPriority: ReviewPriority | undefined,
  detail: string | undefined,
): DossierEntryView => {
  const projection = projectBugClaimCluster(entry.bugClaims)
  const core = {
    ...projection,
    tag,
    reviewPriority,
    detail,
  }
  return entry.testSuggestion === undefined
    ? core
    : { ...core, testSuggestion: entry.testSuggestion }
}

export const viewDossier = (dossier: Dossier): DossierView => ({
  findings: dossier.findings.map((entry) =>
    DossierFinding.guards.Confirmed(entry)
      ? claimEntry(
        entry,
        "confirmed",
        entry.verdict.reviewPriority,
        entry.verdict.evidence,
      )
      : {
        candidate: entry.candidate,
        lenses: [entry.candidate.lens],
        tag: "judgment",
        reviewPriority: entry.judgment.reviewPriority,
        detail: entry.judgment.reason,
      }
  ),
  unresolved: dossier.unresolved.map((entry) =>
    DossierUnresolved.guards.Unverified(entry)
      ? claimEntry(
        entry,
        "unverified",
        entry.verdict.reviewPriority,
        entry.verdict.evidence,
      )
      : {
        candidate: entry.candidate,
        lenses: [entry.candidate.lens],
        tag: "undecided",
      }
  ),
  refutedClaims: dossier.rejected.refutedClaims.map((entry) =>
    claimEntry(entry, "refuted", undefined, entry.verdict.evidence)
  ),
  droppedObservations: dossier.rejected.droppedObservations.map((entry) => ({
    candidate: entry.candidate,
    lenses: [entry.candidate.lens],
    tag: "dropped",
    detail: entry.judgment.reason,
  })),
})
