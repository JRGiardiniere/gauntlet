import * as Array from "effect/Array"
import * as Record from "effect/Record"
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

// Longer text carries more of the claim: summary and failure scenario are the
// two model-authored fields a cluster-mate can state more fully than the rest.
const substance = (candidate: BugClaim): number =>
  candidate.summary.length + candidate.failureScenario.length

const representativeClaim = (
  candidates: readonly [BugClaim, ...Array<BugClaim>],
): BugClaim =>
  candidates.slice(1).reduce(
    (fullest, candidate) =>
      substance(candidate) > substance(fullest) ? candidate : fullest,
    candidates[0],
  )

const lensesOf = (
  candidates: readonly [BugClaim, ...Array<BugClaim>],
): ReadonlyArray<string> =>
  Array.dedupe(candidates.map(({ lens }) => lens))

interface ClusteredBugClaim extends EvaluatedBugClaim {
  readonly lenses: ReadonlyArray<string>
}

// Stage progress still needs a tally before final Dossier assembly. Pool
// cluster-mates count as one evaluated claim in that tally.
const clusterEvaluatedBugClaims = (
  bugClaims: ReadonlyArray<EvaluatedBugClaim>,
): ReadonlyArray<ClusteredBugClaim> =>
  Record.values(Array.groupBy(bugClaims, ({ cluster }) => String(cluster)))
    .map((mates) => ({
      ...Array.reduce(
        mates,
        Array.headNonEmpty(mates),
        (fullest, mate) =>
          substance(mate.candidate) > substance(fullest.candidate)
            ? mate
            : fullest,
      ),
      lenses: Array.dedupe(Array.map(mates, ({ candidate }) => candidate.lens)),
    }))

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
    readonly bugClaims: readonly [BugClaim, ...Array<BugClaim>]
    readonly testSuggestion?: TestSuggestion
  },
  tag: "confirmed" | "unverified" | "refuted",
  reviewPriority: ReviewPriority | undefined,
  detail: string | undefined,
): DossierEntryView => {
  const core = {
    candidate: representativeClaim(entry.bugClaims),
    lenses: lensesOf(entry.bugClaims),
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
