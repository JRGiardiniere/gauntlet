import * as Array from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import type { Observation } from "../../domain/candidate.ts"
import type { JudgedObservation } from "../../domain/dossier.ts"
import { Judgment } from "../../domain/judgment.ts"
import type { JudgmentsOutput } from "./output-contract.ts"

export interface IndexedObservation {
  readonly index: number
  readonly candidate: Observation
}

type ReportedJudgment = JudgmentsOutput["decisions"][number]

export interface JudgmentResolution {
  readonly observations: ReadonlyArray<JudgedObservation>
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

// Phase 1 — one decision per index. A second decision for the same index
// fails closed: the index becomes undecided and no later decision revives it.
interface DecisionLedger {
  readonly decided: HashMap.HashMap<number, ReportedJudgment>
  readonly conflicted: HashSet.HashSet<number>
  readonly conflictedIndexes: ReadonlyArray<number>
}

const indexDecisions = (
  decisions: ReadonlyArray<ReportedJudgment>,
): DecisionLedger => {
  let decided = HashMap.empty<number, ReportedJudgment>()
  let conflicted = HashSet.empty<number>()
  const conflictedIndexes: Array<number> = []
  for (const decision of decisions) {
    if (HashSet.has(conflicted, decision.index)) continue
    if (HashMap.has(decided, decision.index)) {
      conflicted = HashSet.add(conflicted, decision.index)
      conflictedIndexes.push(decision.index)
      decided = HashMap.remove(decided, decision.index)
    } else {
      decided = HashMap.set(decided, decision.index, decision)
    }
  }
  return { decided, conflicted, conflictedIndexes }
}

// Phase 2 — map each merged index to its keeper. A merge must name another
// index whose own decision is keep; any other merge leaves its index
// undecided. The diagnostic buckets hold the merging indexes.
interface MergePlan {
  readonly mergedInto: HashMap.HashMap<number, number>
  readonly selfMerges: ReadonlyArray<number>
  readonly unknownTargets: ReadonlyArray<number>
  readonly unkeptTargets: ReadonlyArray<number>
}

const planMerges = (
  observations: ReadonlyArray<IndexedObservation>,
  validIndexes: HashSet.HashSet<number>,
  ledger: DecisionLedger,
): MergePlan => {
  const selfMerges: Array<number> = []
  const unknownTargets: Array<number> = []
  const unkeptTargets: Array<number> = []
  let mergedInto = HashMap.empty<number, number>()
  for (const { index } of observations) {
    const decision = HashMap.get(ledger.decided, index)
    if (Option.isNone(decision) || decision.value.decision !== "merge") continue
    const { into } = decision.value
    const keeper = HashMap.get(ledger.decided, into)
    if (into === index) {
      selfMerges.push(index)
    } else if (!HashSet.has(validIndexes, into)) {
      unknownTargets.push(index)
    } else if (Option.isNone(keeper) || keeper.value.decision !== "keep") {
      unkeptTargets.push(index)
    } else {
      mergedInto = HashMap.set(mergedInto, index, into)
    }
  }
  return { mergedInto, selfMerges, unknownTargets, unkeptTargets }
}

// Phase 3 — walk the observations in order and produce exactly one Kept,
// Dropped, or Undecided entry per unmerged index.
interface Materialized {
  readonly observations: ReadonlyArray<JudgedObservation>
  readonly undecidedIndexes: ReadonlyArray<number>
  readonly discardedQualityNotes: ReadonlyArray<number>
}

const materialize = (
  observations: ReadonlyArray<IndexedObservation>,
  ledger: DecisionLedger,
  plan: MergePlan,
): Materialized => {
  let mergedIds = HashMap.empty<number, ReadonlyArray<string>>()
  for (const { candidate, index } of observations) {
    const keeper = HashMap.get(plan.mergedInto, index)
    if (Option.isNone(keeper)) continue
    mergedIds = HashMap.modifyAt(mergedIds, keeper.value, (ids) =>
      Option.some([...Option.getOrElse(ids, () => []), candidate.id]))
  }

  const undecidedIndexes: Array<number> = []
  const discardedQualityNotes: Array<number> = []
  const resolved = Array.flatMap(
    observations,
    ({ candidate, index }): ReadonlyArray<JudgedObservation> => {
      if (HashMap.has(plan.mergedInto, index)) return []
      const decision = HashMap.get(ledger.decided, index)
      if (Option.isNone(decision) || decision.value.decision === "merge") {
        if (Option.isNone(decision) && !HashSet.has(ledger.conflicted, index)) {
          undecidedIndexes.push(index)
        }
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
      const core = {
        reviewPriority: decision.value.review_priority,
        reason: decision.value.reason,
        goodFind,
        cleanlyExplained,
        mergedCandidateIds: Option.getOrElse(
          HashMap.get(mergedIds, index),
          () => [],
        ),
      }
      // The contract admits a quality note only when a rating is false.
      if (qualityNote !== undefined && !(goodFind && cleanlyExplained)) {
        return [{
          candidate,
          judgment: Judgment.cases.Kept.make({ ...core, qualityNote }),
        }]
      }
      if (qualityNote !== undefined) discardedQualityNotes.push(index)
      return [{ candidate, judgment: Judgment.cases.Kept.make(core) }]
    },
  )
  return { observations: resolved, undecidedIndexes, discardedQualityNotes }
}

// Judgment output is advisory model text resolved against the paid
// Observation set. Each index takes exactly one decision: conflicting
// decisions fail closed to undecided, and a merge that names no other kept
// index leaves its own index undecided. Every discarded claim surfaces as a
// note (docs/spec/pipeline-shape.md).
export const resolveJudgment = (
  observations: ReadonlyArray<IndexedObservation>,
  output: JudgmentsOutput | undefined,
): JudgmentResolution => {
  const validIndexes = HashSet.fromIterable(
    Array.map(observations, ({ index }) => index),
  )
  const known: Array<ReportedJudgment> = []
  const unknown: Array<ReportedJudgment> = []
  for (const decision of output?.decisions ?? []) {
    if (HashSet.has(validIndexes, decision.index)) known.push(decision)
    else unknown.push(decision)
  }

  const ledger = indexDecisions(known)
  const plan = planMerges(observations, validIndexes, ledger)
  const materialized = materialize(observations, ledger, plan)

  return {
    observations: materialized.observations,
    notes: [
      ...note(
        "ignored decisions for unknown indexes",
        Array.map(unknown, ({ index }) => index),
      ),
      ...note(
        "retained conflicting decisions as undecided for indexes",
        ledger.conflictedIndexes,
      ),
      ...note("ignored self-merges of indexes", plan.selfMerges),
      ...note("ignored merges into an unknown index by indexes", plan.unknownTargets),
      ...note("ignored merges into an unkept index by indexes", plan.unkeptTargets),
      ...note(
        "ignored quality notes on cleanly rated keeps",
        materialized.discardedQualityNotes,
      ),
      ...note("retained undecided indexes", materialized.undecidedIndexes),
    ],
  }
}
