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

export interface JudgmentResolution {
  readonly observations: Dossier["observations"]
  readonly notes: ReadonlyArray<string>
}

export const indexObservations = (
  candidates: ReadonlyArray<Observation>,
): ReadonlyArray<IndexedObservation> =>
  Array.map(candidates, (candidate, index) => ({
    index: index + 1,
    candidate,
  }))

const note = (
  label: string,
  indexes: ReadonlyArray<number>,
): ReadonlyArray<string> =>
  indexes.length === 0 ? [] : [`${label} ${indexes.join(", ")}`]

// Judgment output is advisory model text resolved against the paid
// Observation set. Three precedence rules keep every index accounted for
// exactly once: an index's own decision always beats a merge claim on it,
// conflicting decisions fail closed to undecided, and the first keeper to
// claim a merge target wins. Every discarded claim surfaces as a note
// (docs/spec/pipeline-shape.md).
export const resolveJudgment = (
  observations: ReadonlyArray<IndexedObservation>,
  output: JudgmentsOutput | undefined,
): JudgmentResolution => {
  const validIndexes = HashSet.fromIterable(
    Array.map(observations, ({ index }) => index),
  )
  const [unknown, known] = Array.partition(
    output?.decisions ?? [],
    (decision) =>
      HashSet.has(validIndexes, decision.index)
        ? Result.succeed(decision)
        : Result.fail(decision),
  )

  let decided = HashMap.empty<number, ReportedJudgment>()
  let conflicted = HashSet.empty<number>()
  const conflictedIndexes: Array<number> = []
  for (const decision of known) {
    if (HashSet.has(conflicted, decision.index)) continue
    if (HashMap.has(decided, decision.index)) {
      conflicted = HashSet.add(conflicted, decision.index)
      conflictedIndexes.push(decision.index)
      decided = HashMap.remove(decided, decision.index)
    } else {
      decided = HashMap.set(decided, decision.index, decision)
    }
  }

  const selfMergeIndexes: Array<number> = []
  const unknownTargetIndexes: Array<number> = []
  const decidedTargetIndexes: Array<number> = []
  const contestedTargetIndexes: Array<number> = []
  let mergedInto = HashMap.empty<number, number>()
  for (const decision of known) {
    if (decision.decision !== "keep") continue
    if (HashSet.has(conflicted, decision.index)) continue
    for (const target of decision.merge ?? []) {
      if (target === decision.index) {
        selfMergeIndexes.push(target)
      } else if (!HashSet.has(validIndexes, target)) {
        unknownTargetIndexes.push(target)
      } else if (
        HashMap.has(decided, target) || HashSet.has(conflicted, target)
      ) {
        decidedTargetIndexes.push(target)
      } else if (HashMap.has(mergedInto, target)) {
        contestedTargetIndexes.push(target)
      } else {
        mergedInto = HashMap.set(mergedInto, target, decision.index)
      }
    }
  }

  let mergedIds = HashMap.empty<number, ReadonlyArray<string>>()
  for (const { candidate, index } of observations) {
    const keeper = HashMap.get(mergedInto, index)
    if (Option.isNone(keeper)) continue
    mergedIds = HashMap.modifyAt(mergedIds, keeper.value, (ids) =>
      Option.some([...Option.getOrElse(ids, () => []), candidate.id]))
  }

  const undecidedIndexes: Array<number> = []
  const resolved = Array.flatMap(
    observations,
    ({ candidate, index }): Dossier["observations"] => {
      if (HashMap.has(mergedInto, index)) return []
      const decision = HashMap.get(decided, index)
      if (Option.isNone(decision)) {
        if (!HashSet.has(conflicted, index)) undecidedIndexes.push(index)
        return [{ candidate, judgment: Judgment.cases.Undecided.make({}) }]
      }
      if (decision.value.decision === "drop") {
        return [{
          candidate,
          judgment: Judgment.cases.Dropped.make({
            reason: decision.value.reason,
          }),
        }]
      }
      const { cleanlyExplained, goodFind, qualityNote } = decision.value
      return [{
        candidate,
        judgment: Judgment.cases.Kept.make({
          tier: decision.value.tier,
          reason: decision.value.reason,
          goodFind,
          cleanlyExplained,
          // The contract admits a quality note only when a rating is false.
          ...(qualityNote !== undefined && !(goodFind && cleanlyExplained)
            ? { qualityNote }
            : {}),
          mergedCandidateIds: Option.getOrElse(
            HashMap.get(mergedIds, index),
            () => [],
          ),
        }),
      }]
    },
  )

  return {
    observations: resolved,
    notes: [
      ...note(
        "ignored decisions for unknown indexes",
        Array.map(unknown, ({ index }) => index),
      ),
      ...note(
        "retained conflicting decisions as undecided for indexes",
        conflictedIndexes,
      ),
      ...note("ignored self-merges of indexes", selfMergeIndexes),
      ...note("ignored merges of unknown indexes", unknownTargetIndexes),
      ...note(
        "ignored merges of explicitly decided indexes",
        decidedTargetIndexes,
      ),
      ...note(
        "ignored competing merge claims for indexes",
        contestedTargetIndexes,
      ),
      ...note("retained undecided indexes", undecidedIndexes),
    ],
  }
}
