import {
  type BugClaimCluster,
  projectBugClaimCluster,
} from "../assembly/bug-claim-cluster.ts"
import type { Candidate } from "../domain/candidate.ts"
import {
  DossierFinding,
  DossierUnresolved,
  type Dossier,
  type TestSuggestion,
} from "../domain/dossier.ts"
import type { ReviewPriority } from "../domain/verdict.ts"

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
