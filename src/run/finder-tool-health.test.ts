import { describe, expect, it } from "@effect/vitest"
import type { FinderResult } from "../assembly/finders.ts"
import type { AgentOutcome, AgentToolCalls } from "../domain/agent-outcome.ts"
import { DEFAULT_CANDIDATE_CAP, type FrozenLens } from "../domain/review-plan.ts"
import type { FindingsOutput } from "../harness/output-contract.ts"
import {
  isFinderToolCascade,
  measureFinderToolHealth,
} from "./finder-tool-health.ts"

const lens = (name: string): FrozenLens => ({
  name,
  promptText: `${name} prompt`,
  seat: "fixture/tool-model:low",
  candidateCap: DEFAULT_CANDIDATE_CAP,
})

const outcome = (toolCalls: AgentToolCalls): AgentOutcome<FindingsOutput> => ({
  termination: { _tag: "Completed" },
  output: { findings: [] },
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    costUsd: 0,
    rawRows: [],
  },
  toolCalls,
  durationMillis: 0,
  diagnostics: [],
})

const result = (name: string, total: number, errored: number): FinderResult => ({
  lens: lens(name),
  outcome: outcome({ total, errored }),
})

describe("Finder tool health", () => {
  it("sums calls across finders that made any and counts the fully dead ones", () => {
    const health = measureFinderToolHealth([
      result("clean", 5, 0),
      result("flaky", 4, 1),
      result("dead", 3, 3),
      result("idle", 0, 0),
    ])
    expect(health).toEqual({
      calls: 12,
      errored: 4,
      finderCount: 3,
      deadFinderCount: 1,
    })
    expect(measureFinderToolHealth([result("idle", 0, 0)])).toBeUndefined()
  })

  it("calls a cascade only when half of a non-trivial call count errored", () => {
    const at = (calls: number, errored: number) =>
      isFinderToolCascade({ calls, errored, finderCount: 1, deadFinderCount: 0 })
    expect(at(30, 2)).toBe(false)
    expect(at(2, 2)).toBe(false)
    expect(at(4, 2)).toBe(true)
    expect(at(24, 24)).toBe(true)
  })
})
