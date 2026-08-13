import type { BugClaim, Observation } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { Verdict } from "../domain/verdict.ts"

export interface ConfirmedClaim {
  readonly candidate: BugClaim
  readonly verdict: typeof Verdict.cases.Confirmed.Type
}
export interface UnverifiedClaim {
  readonly candidate: BugClaim
  readonly verdict: typeof Verdict.cases.Unverified.Type
}
export interface RefutedClaim {
  readonly candidate: BugClaim
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

// One deterministic partition of the Dossier shared by report and digest —
// presentation partitions, never filters silently (docs/spec/pipeline-shape.md).
export interface DossierView {
  readonly confirmed: ReadonlyArray<ConfirmedClaim>
  readonly unverified: ReadonlyArray<UnverifiedClaim>
  readonly refuted: ReadonlyArray<RefutedClaim>
  readonly kept: ReadonlyArray<KeptObservation>
  readonly undecided: ReadonlyArray<Observation>
  readonly dropped: ReadonlyArray<DroppedObservation>
}

export const viewBugClaims = (
  bugClaims: Dossier["bugClaims"],
): Pick<DossierView, "confirmed" | "unverified" | "refuted"> => ({
  confirmed: bugClaims.flatMap(({ candidate, verdict }) =>
    Verdict.guards.Confirmed(verdict) ? [{ candidate, verdict }] : []
  ),
  unverified: bugClaims.flatMap(({ candidate, verdict }) =>
    Verdict.guards.Unverified(verdict) ? [{ candidate, verdict }] : []
  ),
  refuted: bugClaims.flatMap(({ candidate, verdict }) =>
    Verdict.guards.Refuted(verdict) ? [{ candidate, verdict }] : []
  ),
})

export const viewObservations = (
  observations: Dossier["observations"],
): Pick<DossierView, "kept" | "undecided" | "dropped"> => ({
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

export const viewDossier = (dossier: Dossier): DossierView => ({
  ...viewBugClaims(dossier.bugClaims),
  ...viewObservations(dossier.observations),
})
