import * as Array from "effect/Array"
import * as Record from "effect/Record"
import type { BugClaim } from "../domain/candidate.ts"
import type { EvaluatedBugClaim } from "../domain/dossier.ts"

export type BugClaimCluster = readonly [BugClaim, ...Array<BugClaim>]

export interface BugClaimClusterProjection {
  readonly candidate: BugClaim
  readonly lenses: ReadonlyArray<string>
}

const substance = (candidate: BugClaim): number =>
  candidate.summary.length + candidate.failureScenario.length

// One presentation decision for both intermediate tallies and final reports:
// the fullest cluster-mate speaks, while every contributing Lens is credited.
export const projectBugClaimCluster = (
  bugClaims: BugClaimCluster,
): BugClaimClusterProjection => ({
  candidate: bugClaims.slice(1).reduce(
    (fullest, candidate) =>
      substance(candidate) > substance(fullest) ? candidate : fullest,
    bugClaims[0],
  ),
  lenses: Array.dedupe(bugClaims.map(({ lens }) => lens)),
})

export interface EvaluatedBugClaimCluster extends BugClaimClusterProjection {
  readonly cluster: number
  readonly bugClaims: BugClaimCluster
  readonly verdict: EvaluatedBugClaim["verdict"]
}

export const clusterEvaluatedBugClaims = (
  bugClaims: ReadonlyArray<EvaluatedBugClaim>,
): ReadonlyArray<EvaluatedBugClaimCluster> =>
  Record.values(Array.groupBy(bugClaims, ({ cluster }) => String(cluster)))
    .map((mates) => {
      const first = Array.headNonEmpty(mates)
      const clustered: [BugClaim, ...Array<BugClaim>] = [
        first.candidate,
        ...mates.slice(1).map(({ candidate }) => candidate),
      ]
      return {
        cluster: first.cluster,
        bugClaims: clustered,
        verdict: first.verdict,
        ...projectBugClaimCluster(clustered),
      }
    })
