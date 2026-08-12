import * as Array from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { Observation } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import type { JudgmentsOutput } from "../harness/output-contract.ts"

export interface IndexedObservation {
  readonly index: number
  readonly candidate: Observation
}

type ReportedJudgment = JudgmentsOutput["decisions"][number]
type ReportedKeep = Extract<ReportedJudgment, { readonly decision: "keep" }>

export interface JudgmentRepair {
  readonly observations: Dossier["observations"]
  readonly unknownIndexes: ReadonlyArray<number>
  readonly duplicateIndexes: ReadonlyArray<number>
  readonly selfMergeIndexes: ReadonlyArray<number>
  readonly unknownMergeIndexes: ReadonlyArray<number>
  readonly removedKeeperIndexes: ReadonlyArray<number>
  readonly undecidedIndexes: ReadonlyArray<number>
}

export const indexObservations = (
  candidates: ReadonlyArray<Observation>,
): ReadonlyArray<IndexedObservation> =>
  Array.map(candidates, (candidate, index) => ({
    index: index + 1,
    candidate,
  }))

const lastDecisionsByIndex = (
  decisions: ReadonlyArray<ReportedJudgment>,
): HashMap.HashMap<number, ReportedJudgment> =>
  HashMap.fromIterable(
    Array.map(decisions, (decision) => [decision.index, decision] as const),
  )

// Judgment merge claims are advisory model output. Resolve them against the
// paid Observation set so a self-merge, unknown keeper, or keeper that another
// merge removes cannot hide a candidate (docs/spec/pipeline-shape.md).
export const resolveJudgment = (
  observations: ReadonlyArray<IndexedObservation>,
  output: JudgmentsOutput | undefined,
): JudgmentRepair => {
  const decisions = output?.decisions ?? []
  const validIndexes = HashSet.fromIterable(
    Array.map(observations, ({ index }) => index),
  )
  const byIndex = lastDecisionsByIndex(decisions)
  const unknownIndexes = Array.filterMap(decisions, (decision) =>
    HashSet.has(validIndexes, decision.index)
      ? Result.fail(undefined)
      : Result.succeed(decision.index)
  )
  let seen = HashSet.empty<number>()
  const duplicateIndexes = Array.filterMap(decisions, (decision) => {
    if (HashSet.has(seen, decision.index)) {
      return Result.succeed(decision.index)
    }
    seen = HashSet.add(seen, decision.index)
    return Result.fail(undefined)
  })

  const keepDecisions: ReadonlyArray<ReportedKeep> = Array.filter(
    Array.fromIterable(HashMap.values(byIndex)),
    (decision): decision is ReportedKeep =>
      decision.decision === "keep" &&
      HashSet.has(validIndexes, decision.index),
  )
  const selfMergeIndexes: Array<number> = []
  const unknownMergeIndexes: Array<number> = []
  let tentativelyMerged = HashSet.empty<number>()
  for (const decision of keepDecisions) {
    for (const index of decision.merge ?? []) {
      if (index === decision.index) {
        selfMergeIndexes.push(index)
      } else if (!HashSet.has(validIndexes, index)) {
        unknownMergeIndexes.push(index)
      } else {
        tentativelyMerged = HashSet.add(tentativelyMerged, index)
      }
    }
  }

  const emittedKeepers = HashSet.fromIterable(
    Array.filterMap(keepDecisions, (decision) =>
      HashSet.has(tentativelyMerged, decision.index)
        ? Result.fail(undefined)
        : Result.succeed(decision.index)
    ),
  )
  const removedKeeperIndexes = Array.filterMap(keepDecisions, (decision) =>
    HashSet.has(emittedKeepers, decision.index) || decision.merge === undefined
      ? Result.fail(undefined)
      : Result.succeed(decision.index)
  )

  let mergedInto = HashMap.empty<number, number>()
  for (const decision of keepDecisions) {
    if (!HashSet.has(emittedKeepers, decision.index)) continue
    for (const index of decision.merge ?? []) {
      if (index !== decision.index && HashSet.has(validIndexes, index)) {
        mergedInto = HashMap.set(mergedInto, index, decision.index)
      }
    }
  }

  let acceptedMerges = HashMap.empty<number, ReadonlyArray<string>>()
  for (const observation of observations) {
    const keeper = HashMap.get(mergedInto, observation.index)
    if (Option.isNone(keeper)) continue
    acceptedMerges = HashMap.modifyAt(acceptedMerges, keeper.value, (ids) =>
      Option.some([...Option.getOrElse(ids, () => []), observation.candidate.id])
    )
  }

  const undecidedIndexes: Array<number> = []
  const resolved = Array.reduce(
    observations,
    [] as Array<Dossier["observations"][number]>,
    (judged, { candidate, index }) => {
      if (HashMap.has(mergedInto, index)) return judged
      const decision = HashMap.get(byIndex, index)
      if (Option.isNone(decision)) {
        undecidedIndexes.push(index)
        judged.push({
          candidate,
          judgment: Judgment.cases.Undecided.make({}),
        })
        return judged
      }
      if (decision.value.decision === "drop") {
        judged.push({
          candidate,
          judgment: Judgment.cases.Dropped.make({
            reason: decision.value.reason,
          }),
        })
        return judged
      }
      judged.push({
        candidate,
        judgment: Judgment.cases.Kept.make({
          tier: decision.value.tier,
          reason: decision.value.reason,
          goodFind: decision.value.goodFind,
          cleanlyExplained: decision.value.cleanlyExplained,
          ...(decision.value.qualityNote === undefined
            ? {}
            : { qualityNote: decision.value.qualityNote }),
          mergedCandidateIds: Option.getOrElse(
            HashMap.get(acceptedMerges, index),
            () => [],
          ),
        }),
      })
      return judged
    },
  )

  return {
    observations: resolved,
    unknownIndexes,
    duplicateIndexes,
    selfMergeIndexes,
    unknownMergeIndexes,
    removedKeeperIndexes,
    undecidedIndexes,
  }
}
