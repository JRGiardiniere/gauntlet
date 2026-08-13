import * as Array from "effect/Array"
import * as Record from "effect/Record"
import type { BugClaim, Observation } from "../domain/candidate.ts"
import type { Dossier, EvaluatedBugClaim } from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { Verdict } from "../domain/verdict.ts"

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

// Longer text carries more of the claim: summary and failure scenario are the
// two model-authored fields a cluster-mate can state more fully than the rest.
const substance = (candidate: BugClaim): number =>
  candidate.summary.length + candidate.failureScenario.length

interface ClusteredBugClaim extends EvaluatedBugClaim {
  readonly lenses: ReadonlyArray<string>
}

// Pool bundles duplicate claims into one cluster and Verification returns one
// verdict per cluster, so cluster-mates are a single finding several lenses
// raised. Presentation shows the fullest mate attributed to all of them; every
// mate stays in the Dossier.
const clusterBugClaims = (
  bugClaims: Dossier["bugClaims"],
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
  bugClaims: Dossier["bugClaims"],
): Pick<DossierView, "confirmed" | "unverified" | "refuted"> => {
  const clustered = clusterBugClaims(bugClaims)
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
