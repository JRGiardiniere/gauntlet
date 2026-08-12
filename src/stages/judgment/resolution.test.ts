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

const keep = (
  index: number,
  merge?: ReadonlyArray<number>,
) => ({
  index,
  decision: "keep" as const,
  tier: "P2" as const,
  reason: "checked the call sites and confirmed the structural cost",
  goodFind: true,
  cleanlyExplained: true,
  ...(merge === undefined ? {} : { merge }),
})

const drop = (index: number) => ({
  index,
  decision: "drop" as const,
  reason: "repo convention",
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
  it("sanitizes self-merges without poisoning valid siblings", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1, [1, 2])],
    })

    expect(resolved.observations.map(({ candidate }) => candidate.id)).toEqual([
      "fixture/1",
      "fixture/3",
      "fixture/4",
    ])
    expect(resolved.observations[0]?.judgment).toMatchObject({
      _tag: "Kept",
      mergedCandidateIds: ["fixture/2"],
    })
    expect(resolved.notes).toEqual([
      "ignored self-merges of indexes 1",
      "retained undecided indexes 3, 4",
    ])
    expectFullAccounting(resolved)
  })

  it("ignores unknown keepers and unknown merge targets", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(999, [2]), keep(1, [2, 998]), drop(3), drop(4)],
    })

    expect(resolved.observations.map(({ candidate }) => candidate.id)).toEqual([
      "fixture/1",
      "fixture/3",
      "fixture/4",
    ])
    expect(resolved.notes).toEqual([
      "ignored decisions for unknown indexes 999",
      "ignored merges of unknown indexes 998",
    ])
    expectFullAccounting(resolved)
  })

  it("never lets a merge claim override an explicit decision", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1, [2, 3]), drop(2), keep(3)],
    })

    expect(resolved.observations.map(({ judgment }) => judgment._tag)).toEqual([
      "Kept",
      "Dropped",
      "Kept",
      "Undecided",
    ])
    expect(resolved.observations[0]?.judgment).toMatchObject({
      _tag: "Kept",
      mergedCandidateIds: [],
    })
    expect(resolved.notes).toEqual([
      "ignored merges of explicitly decided indexes 2, 3",
      "retained undecided indexes 4",
    ])
    expectFullAccounting(resolved)
  })

  it("fails conflicting decisions closed to undecided", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1, [2]), drop(1), drop(2), keep(3), keep(4)],
    })

    expect(resolved.observations.map(({ judgment }) => judgment._tag)).toEqual([
      "Undecided",
      "Dropped",
      "Kept",
      "Kept",
    ])
    expect(resolved.notes).toEqual([
      "retained conflicting decisions as undecided for indexes 1",
    ])
    expectFullAccounting(resolved)
  })

  it("awards a contested merge target to the first keeper that claimed it", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1, [3]), keep(2, [3, 4])],
    })

    expect(resolved.observations[0]?.judgment).toMatchObject({
      _tag: "Kept",
      mergedCandidateIds: ["fixture/3"],
    })
    expect(resolved.observations[1]?.judgment).toMatchObject({
      _tag: "Kept",
      mergedCandidateIds: ["fixture/4"],
    })
    expect(resolved.notes).toEqual([
      "ignored competing merge claims for indexes 3",
    ])
    expectFullAccounting(resolved)
  })

  it("accounts for missing decisions exactly once as undecided", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1, [2]), drop(3)],
    })

    expect(resolved.observations.map(({ judgment }) => judgment._tag)).toEqual([
      "Kept",
      "Dropped",
      "Undecided",
    ])
    expect(resolved.notes).toEqual(["retained undecided indexes 4"])
    expectFullAccounting(resolved)
    expect(new Set(accountedIds(resolved.observations)).size).toBe(4)
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
