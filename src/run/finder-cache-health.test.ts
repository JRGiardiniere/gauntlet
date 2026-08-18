import { describe, expect, it } from "@effect/vitest"
import type * as Schema from "effect/Schema"
import type { FinderResult } from "../assembly/finders.ts"
import type { AgentOutcome } from "../domain/agent-outcome.ts"
import {
  DEFAULT_CANDIDATE_CAP,
  type FrozenLens,
  ReviewPlan,
} from "../domain/review-plan.ts"
import type { Seat } from "../domain/recipe.ts"
import type { ReviewSpecification } from "../domain/review-specification.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import type { FindingsOutput } from "../harness/output-contract.ts"
import { measureLowFinderCacheHealth } from "./finder-cache-health.ts"

const SEAT = "fixture/cache-model:low" as const
const OTHER_SEAT = "fixture/other-model:low" as const

const lens = (
  name: string,
  seat: Seat = SEAT,
  finderClass?: "interpretive",
): FrozenLens => {
  const core = {
    name,
    promptText: `${name} prompt`,
    seat,
    candidateCap: DEFAULT_CANDIDATE_CAP,
  }
  return finderClass === undefined ? core : { ...core, finderClass }
}

const rawUsage = (
  input: number,
  cacheRead: number,
): Schema.Json => ({
  input,
  output: 1,
  cacheRead,
  cacheWrite: 0,
  cost: { total: 0 },
})

const outcome = (
  rawRows: ReadonlyArray<Schema.Json>,
): AgentOutcome<FindingsOutput> => ({
  termination: { _tag: "Completed" },
  output: { findings: [] },
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    costUsd: 0,
    rawRows,
  },
  durationMillis: 0,
  diagnostics: [],
})

const specification: ReviewSpecification = {
  documents: [{
    role: "caller-addendum",
    provenance: "cache health test",
    text: "aggregate cache health across the run",
  }],
  comments: [],
}

const standardStarter = lens("standard-starter")
const standardHealthy = lens("standard-healthy")
const standardLow = lens("standard-low")
const interpretiveStarter = lens("interpretive-starter", SEAT, "interpretive")
const interpretiveMiss = lens("interpretive-miss", SEAT, "interpretive")
const interpretiveLow = lens("interpretive-low", SEAT, "interpretive")
const interpretiveInvalid = lens("interpretive-invalid", SEAT, "interpretive")
const interpretiveMissing = lens("interpretive-missing", SEAT, "interpretive")
const interpretiveZero = lens("interpretive-zero", SEAT, "interpretive")
const singleton = lens("singleton", OTHER_SEAT)
const lenses = [
  standardStarter,
  standardHealthy,
  standardLow,
  interpretiveStarter,
  interpretiveMiss,
  interpretiveLow,
  interpretiveInvalid,
  interpretiveMissing,
  interpretiveZero,
  singleton,
]

const plan = ReviewPlan.make({
  runId: "cache-health-test",
  target: ReviewTarget.cases.WorkingTree.make({
    repoRoot: "/fixture",
    headCommit: "abcdef0",
    changedFiles: ["src/fixture.ts"],
    diff: "+change",
    untrackedFiles: [],
    warnings: [],
  }),
  seats: {},
  lenses,
  specification,
})

const result = (
  plannedLens: FrozenLens,
  rawRows: ReadonlyArray<Schema.Json>,
): FinderResult => ({ lens: plannedLens, outcome: outcome(rawRows) })

describe("Finder cache health", () => {
  it("measures one run-wide low-reuse signal from eligible followers", () => {
    const results = [
      result(standardStarter, [rawUsage(100, 0)]),
      // The second row is a corrective turn and must not lower this follower.
      result(standardHealthy, [rawUsage(20, 80), rawUsage(100, 0)]),
      result(standardLow, [rawUsage(80, 20)]),
      result(interpretiveStarter, [rawUsage(100, 0)]),
      result(interpretiveMiss, [rawUsage(100, 0)]),
      result(interpretiveLow, [rawUsage(80, 20)]),
      result(interpretiveInvalid, [{ drifted: true }]),
      result(interpretiveMissing, []),
      result(interpretiveZero, [rawUsage(0, 0)]),
      result(singleton, [rawUsage(100, 0)]),
    ]

    expect(measureLowFinderCacheHealth(plan, results)).toEqual({
      reuse: 0.3,
      eligibleFollowerCount: 4,
      healthyFollowerCount: 1,
    })
    expect(measureLowFinderCacheHealth(plan, [
      result(standardHealthy, [rawUsage(20, 80)]),
      result(standardLow, [rawUsage(80, 20)]),
    ])).toBeUndefined()
    expect(measureLowFinderCacheHealth(plan, [
      result(standardHealthy, [rawUsage(20, 80)]),
    ])).toBeUndefined()
  })
})
