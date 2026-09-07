import { describe, expect, it } from "@effect/vitest"
import { Candidate } from "../domain/candidate.ts"
import {
  bundlePoolClusters,
  indexBugClaims,
  numberPoolClusters,
  repairPoolOutput,
  singletonClusters,
} from "./pool.ts"

const claim = (id: string) =>
  Candidate.cases.BugClaim.make({
    id,
    lens: "fixture-lens",
    file: `${id}.ts`,
    summary: `summary ${id}`,
    failureScenario: `failure ${id}`,
  })

const claims = indexBugClaims([
  claim("one"),
  claim("two"),
  claim("three"),
  claim("four"),
  claim("five"),
])

describe("Pool repair", () => {
  it("uses singleton clusters when Pool has no decodable output", () => {
    const repaired = repairPoolOutput(claims, undefined)

    expect(repaired.clusters).toEqual([
      { indexes: [1], summary: "summary one" },
      { indexes: [2], summary: "summary two" },
      { indexes: [3], summary: "summary three" },
      { indexes: [4], summary: "summary four" },
      { indexes: [5], summary: "summary five" },
    ])
    expect(repaired.restoredIndexes).toEqual([1, 2, 3, 4, 5])
    expect(repaired.unknownIndexes).toEqual([])
    expect(repaired.duplicateIndexes).toEqual([])
  })

  it("keeps the first valid placement and restores uncovered claims", () => {
    const repaired = repairPoolOutput(claims, {
      clusters: [
        { indexes: [2, 99, 1], summary: "merged one and two" },
        { indexes: [2, 3], summary: "duplicate two" },
        { indexes: [99], summary: "unknown only" },
        { indexes: [5], summary: "five" },
      ],
    })

    expect(repaired.clusters).toEqual([
      { indexes: [2, 1], summary: "summary two" },
      { indexes: [3], summary: "summary three" },
      { indexes: [5], summary: "five" },
      { indexes: [4], summary: "summary four" },
    ])
    expect(repaired.unknownIndexes).toEqual([99, 99])
    expect(repaired.duplicateIndexes).toEqual([2])
    expect(repaired.restoredIndexes).toEqual([4])
  })

  it("numbers clusters across bundles of four", () => {
    const bundles = bundlePoolClusters(
      numberPoolClusters(singletonClusters(claims)),
    )

    expect(bundles.map((bundle) => bundle.map(({ number }) => number))).toEqual([
      [1, 2, 3, 4],
      [5],
    ])
  })
})
