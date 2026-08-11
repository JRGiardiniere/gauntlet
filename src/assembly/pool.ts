import * as Array from "effect/Array"
import * as HashSet from "effect/HashSet"
import * as Result from "effect/Result"
import type { BugClaim } from "../domain/candidate.ts"
import type { PoolOutput } from "../harness/output-contract.ts"

export const POOL_SKIP_UNDER = 3
export const VERIFIER_BUNDLE_SIZE = 4

export interface IndexedBugClaim {
  readonly index: number
  readonly candidate: BugClaim
}

export interface PoolCluster {
  readonly indexes: ReadonlyArray<number>
  readonly summary: string
}

export interface NumberedPoolCluster extends PoolCluster {
  readonly number: number
}

export interface PoolRepair {
  readonly clusters: ReadonlyArray<PoolCluster>
  readonly unknownIndexes: ReadonlyArray<number>
  readonly duplicateIndexes: ReadonlyArray<number>
  readonly restoredIndexes: ReadonlyArray<number>
}

export const indexBugClaims = (
  candidates: ReadonlyArray<BugClaim>,
): ReadonlyArray<IndexedBugClaim> =>
  Array.map(candidates, (candidate, index) => ({
    index: index + 1,
    candidate,
  }))

export const singletonClusters = (
  claims: ReadonlyArray<IndexedBugClaim>,
): ReadonlyArray<PoolCluster> =>
  Array.map(claims, ({ candidate, index }) => ({
    indexes: [index],
    summary: candidate.summary,
  }))

// Pool output is an execution plan, not domain truth. Preserve its first valid
// placement for each claim, discard impossible placements, then restore every
// uncovered paid claim as a singleton (docs/spec/pipeline-shape.md).
export const repairPoolOutput = (
  claims: ReadonlyArray<IndexedBugClaim>,
  output: PoolOutput | undefined,
): PoolRepair => {
  const validIndexes = HashSet.fromIterable(Array.map(claims, ({ index }) => index))
  let seen = HashSet.empty<number>()
  const unknownIndexes: Array<number> = []
  const duplicateIndexes: Array<number> = []

  const clusters = Array.filterMap(output?.clusters ?? [], (cluster) => {
    const indexes = Array.filter(cluster.indexes, (index) => {
      if (!HashSet.has(validIndexes, index)) {
        unknownIndexes.push(index)
        return false
      }
      if (HashSet.has(seen, index)) {
        duplicateIndexes.push(index)
        return false
      }
      seen = HashSet.add(seen, index)
      return true
    })
    return indexes.length === 0
      ? Result.fail(undefined)
      : Result.succeed({ indexes, summary: cluster.summary })
  })

  const restored = Array.filter(claims, ({ index }) => !HashSet.has(seen, index))
  return {
    clusters: [...clusters, ...singletonClusters(restored)],
    unknownIndexes,
    duplicateIndexes,
    restoredIndexes: Array.map(restored, ({ index }) => index),
  }
}

export const numberPoolClusters = (
  clusters: ReadonlyArray<PoolCluster>,
): ReadonlyArray<NumberedPoolCluster> =>
  Array.map(clusters, (cluster, index) => ({
    ...cluster,
    number: index + 1,
  }))

export const bundlePoolClusters = (
  clusters: ReadonlyArray<NumberedPoolCluster>,
): ReadonlyArray<ReadonlyArray<NumberedPoolCluster>> =>
  Array.chunksOf(clusters, VERIFIER_BUNDLE_SIZE)
