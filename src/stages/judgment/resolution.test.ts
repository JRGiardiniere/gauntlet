import { describe, expect, it } from "@effect/vitest"
import * as Array from "effect/Array"
import { Candidate } from "../../domain/candidate.ts"
import { Judgment } from "../../domain/judgment.ts"
import { indexObservations, resolveJudgment } from "./resolution.ts"

const observations = indexObservations(
  Array.makeBy(4, (index) =>
    Candidate.cases.Observation.make({
      id: `fixture/${String(index + 1)}`,
      lens: "fixture",
      file: "src/fixture.ts",
      summary: `observation ${String(index + 1)}`,
    })),
)

const keep = (index: number) => ({
  index,
  decision: "keep" as const,
  review_priority: "P2" as const,
  reason: "checked the call sites and confirmed the structural cost",
  goodFind: true,
  cleanlyExplained: true,
})

const drop = (index: number) => ({
  index,
  decision: "drop" as const,
  reason: "repo convention",
})

const merge = (index: number, into: number) => ({
  index,
  decision: "merge" as const,
  into,
  reason: "same root observation",
})

const accountedIds = (
  resolved: ReturnType<typeof resolveJudgment>["observations"],
) =>
  resolved.flatMap(({ candidate, judgment }) => [
    candidate.id,
    ...(Judgment.guards.Kept(judgment)
      ? judgment.mergedCandidateIds
      : []),
  ])

const expectFullAccounting = (
  resolved: ReturnType<typeof resolveJudgment>,
) => {
  expect(accountedIds(resolved.observations).sort()).toEqual(
    observations.map(({ candidate }) => candidate.id).sort(),
  )
}

describe("Judgment resolution and Assembly accounting", () => {
  it("folds merged duplicates into their keeper", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [merge(2, 1), keep(1), drop(3), merge(4, 1)],
    })

    expect(resolved.observations.map(({ candidate }) => candidate.id)).toEqual([
      "fixture/1",
      "fixture/3",
    ])
    expect(resolved.observations[0]?.judgment).toMatchObject({
      _tag: "Kept",
      mergedCandidateIds: ["fixture/2", "fixture/4"],
    })
    expect(resolved.notes).toEqual([])
    expectFullAccounting(resolved)
  })

  it("leaves a merge into itself, an unknown or an unkept index undecided", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [merge(1, 1), merge(2, 998), merge(3, 4), drop(4), keep(999)],
    })

    expect(resolved.observations.map(({ judgment }) => judgment._tag)).toEqual([
      "Undecided",
      "Undecided",
      "Undecided",
      "Dropped",
    ])
    expect(resolved.notes).toEqual([
      "ignored decisions for unknown indexes 999",
      "ignored self-merges of indexes 1",
      "ignored merges into an unknown index by indexes 2",
      "ignored merges into an unkept index by indexes 3",
    ])
    expectFullAccounting(resolved)
  })

  it("fails conflicting decisions closed to undecided", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1), merge(1, 3), drop(2), keep(3), merge(4, 1)],
    })

    expect(resolved.observations.map(({ judgment }) => judgment._tag)).toEqual([
      "Undecided",
      "Dropped",
      "Kept",
      "Undecided",
    ])
    expect(resolved.notes).toEqual([
      "retained conflicting decisions as undecided for indexes 1",
      "ignored merges into an unkept index by indexes 4",
    ])
    expectFullAccounting(resolved)
  })

  it("accounts for missing decisions exactly once as undecided", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1), merge(2, 1), drop(3)],
    })

    expect(resolved.observations.map(({ judgment }) => judgment._tag)).toEqual([
      "Kept",
      "Dropped",
      "Undecided",
    ])
    expect(resolved.notes).toEqual(["retained undecided indexes 4"])
    expectFullAccounting(resolved)
  })

  it("admits a quality note only when a rating is false, noting the discard", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [
        { ...keep(1), qualityNote: "spurious note" },
        { ...keep(2), cleanlyExplained: false, qualityNote: "hard to act on" },
        drop(3),
        drop(4),
      ],
    })

    expect(resolved.observations[0]?.judgment).not.toHaveProperty("qualityNote")
    expect(resolved.observations[1]?.judgment).toMatchObject({
      _tag: "Kept",
      qualityNote: "hard to act on",
    })
    expect(resolved.notes).toEqual([
      "ignored quality notes on cleanly rated keeps 1",
    ])
  })
})
