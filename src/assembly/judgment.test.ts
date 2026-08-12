import { describe, expect, it } from "@effect/vitest"
import * as Array from "effect/Array"
import { Candidate } from "../domain/candidate.ts"
import { Judgment } from "../domain/judgment.ts"
import { indexObservations, resolveJudgment } from "./judgment.ts"

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

const accountedIds = (
  resolved: ReturnType<typeof resolveJudgment>["observations"],
) =>
  resolved.flatMap(({ candidate, judgment }) => [
    candidate.id,
    ...(Judgment.guards.Kept(judgment)
      ? judgment.mergedCandidateIds
      : []),
  ])

describe("Judgment resolution and Assembly accounting", () => {
  it("sanitizes self-merges without poisoning valid siblings", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [keep(1, [1, 2])],
    })

    expect(resolved.selfMergeIndexes).toEqual([1])
    expect(resolved.observations.map(({ candidate }) => candidate.id)).toEqual([
      "fixture/1",
      "fixture/3",
      "fixture/4",
    ])
    expect(resolved.observations[0]?.judgment).toMatchObject({
      _tag: "Kept",
      mergedCandidateIds: ["fixture/2"],
    })
    expect(accountedIds(resolved.observations).sort()).toEqual(
      observations.map(({ candidate }) => candidate.id).sort(),
    )
  })

  it("lets neither an unknown keeper nor a removed keeper hide candidates", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [
        keep(999, [2, 4]),
        keep(3, [4]),
        keep(4, [1, 2]),
      ],
    })

    expect(resolved.unknownIndexes).toEqual([999])
    expect(resolved.removedKeeperIndexes).toEqual([4])
    expect(resolved.observations.map(({ candidate }) => candidate.id)).toEqual([
      "fixture/1",
      "fixture/2",
      "fixture/3",
    ])
    expect(resolved.observations[2]?.judgment).toMatchObject({
      _tag: "Kept",
      mergedCandidateIds: ["fixture/4"],
    })
    expect(accountedIds(resolved.observations).sort()).toEqual(
      observations.map(({ candidate }) => candidate.id).sort(),
    )
  })

  it("accounts for missing decisions exactly once as undecided", () => {
    const resolved = resolveJudgment(observations, {
      decisions: [
        keep(1, [2]),
        { index: 3, decision: "drop", reason: "repo convention" },
      ],
    })

    expect(resolved.undecidedIndexes).toEqual([4])
    expect(resolved.observations.map(({ judgment }) => judgment._tag)).toEqual([
      "Kept",
      "Dropped",
      "Undecided",
    ])
    expect(accountedIds(resolved.observations).sort()).toEqual(
      observations.map(({ candidate }) => candidate.id).sort(),
    )
    expect(new Set(accountedIds(resolved.observations)).size).toBe(4)
  })
})
