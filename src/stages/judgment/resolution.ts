import * as Array from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { Observation } from "../../domain/candidate.ts"
import type { Dossier } from "../../domain/dossier.ts"
import { Judgment } from "../../domain/judgment.ts"
import type { JudgmentsOutput } from "./output-contract.ts"

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

// Phase 2 — map each merge target to its keeper. An index's own decision
// always beats a merge claim on it, and the first keeper to claim a target
// wins; every discarded claim lands in a diagnostic bucket.
interface MergePlan {
  readonly mergedInto: HashMap.HashMap<number, number>
  readonly selfMerges: ReadonlyArray<number>
  readonly unknownTargets: ReadonlyArray<number>
  readonly decidedTargets: ReadonlyArray<number>
  readonly contestedTargets: ReadonlyArray<number>
}

const planMerges = (
  decisions: ReadonlyArray<ReportedJudgment>,
  validIndexes: HashSet.HashSet<number>,
  ledger: DecisionLedger,
): MergePlan => {
  const selfMerges: Array<number> = []
  const unknownTargets: Array<number> = []
  const decidedTargets: Array<number> = []
  const contestedTargets: Array<number> = []
  let mergedInto = HashMap.empty<number, number>()
  for (const decision of decisions) {
    if (decision.decision !== "keep") continue
    if (HashSet.has(ledger.conflicted, decision.index)) continue
    for (const target of decision.merge ?? []) {
      if (target === decision.index) {
        selfMerges.push(target)
      } else if (!HashSet.has(validIndexes, target)) {
        unknownTargets.push(target)
      } else if (
        HashMap.has(ledger.decided, target) ||
        HashSet.has(ledger.conflicted, target)
      ) {
        decidedTargets.push(target)
      } else if (HashMap.has(mergedInto, target)) {
        contestedTargets.push(target)
      } else {
        mergedInto = HashMap.set(mergedInto, target, decision.index)
      }
    }
  }
  return {
    mergedInto,
    selfMerges,
    unknownTargets,
    decidedTargets,
    contestedTargets,
  }
}

// Phase 3 — walk the observations in order and produce exactly one Kept,
// Dropped, or Undecided entry per unmerged index.
interface Materialized {
  readonly observations: Dossier["observations"]
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
    ({ candidate, index }): Dossier["observations"] => {
      if (HashMap.has(plan.mergedInto, index)) return []
      const decision = HashMap.get(ledger.decided, index)
      if (Option.isNone(decision)) {
        if (!HashSet.has(ledger.conflicted, index)) undecidedIndexes.push(index)
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
      // The contract admits a quality note only when a rating is false.
      const noteAdmitted = qualityNote !== undefined &&
        !(goodFind && cleanlyExplained)
      if (qualityNote !== undefined && !noteAdmitted) {
        discardedQualityNotes.push(index)
      }
      return [{
        candidate,
        judgment: Judgment.cases.Kept.make({
          tier: decision.value.tier,
          reason: decision.value.reason,
          goodFind,
          cleanlyExplained,
          ...(noteAdmitted ? { qualityNote } : {}),
          mergedCandidateIds: Option.getOrElse(
            HashMap.get(mergedIds, index),
            () => [],
          ),
        }),
      }]
    },
  )
  return { observations: resolved, undecidedIndexes, discardedQualityNotes }
}

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

  const ledger = indexDecisions(known)
  const plan = planMerges(known, validIndexes, ledger)
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
      ...note("ignored merges of unknown indexes", plan.unknownTargets),
      ...note(
        "ignored merges of explicitly decided indexes",
        plan.decidedTargets,
      ),
      ...note(
        "ignored competing merge claims for indexes",
        plan.contestedTargets,
      ),
      ...note(
        "ignored quality notes on cleanly rated keeps",
        materialized.discardedQualityNotes,
      ),
      ...note("retained undecided indexes", materialized.undecidedIndexes),
    ],
  }
}
