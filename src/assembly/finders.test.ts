import { describe, expect, it } from "@effect/vitest"
import { Termination } from "../domain/agent-outcome.ts"
import { FrozenLens } from "../domain/review-plan.ts"
import { routeFinderResults } from "./finders.ts"

describe("finder assembly", () => {
  it("routes raw Candidates without provisional evaluation", () => {
    const lens = FrozenLens.make({
      name: "fixture-lens",
      promptText: "fixture tail",
      contentHash: "fixture-hash",
      seat: "fixture/fixture-model:low",
      needsSpec: false,
      candidateCap: 6,
    })
    const routed = routeFinderResults([
      {
        lens,
        outcome: {
          termination: Termination.cases.Completed.make({}),
          output: {
            findings: [
              {
                file: "src/a.ts",
                summary: "a refutable defect",
                failure_scenario: "empty input produces the wrong value",
              },
              { file: "src/b.ts", summary: "a judgment call" },
            ],
          },
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: 0,
            costUsd: 0,
            rawRows: [],
          },
          durationMillis: 1,
          diagnostics: [],
        },
      },
    ])

    expect(routed.bugClaims[0]?._tag).toBe("BugClaim")
    expect(routed.observations[0]?._tag).toBe("Observation")
    expect(routed.coverageGaps).toEqual([])
  })

  it("uses a timeout diagnostic to explain a missing finder output", () => {
    const lens = FrozenLens.make({
      name: "fixture-lens",
      promptText: "fixture tail",
      contentHash: "fixture-hash",
      seat: "fixture/fixture-model:low",
      needsSpec: false,
      candidateCap: 6,
    })
    const routed = routeFinderResults([
        {
          lens,
          outcome: {
            termination: Termination.cases.FirstResponseTimeout.make({}),
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              reasoning: 0,
              costUsd: 0,
              rawRows: [],
            },
            durationMillis: 120_000,
            diagnostics: [
              "attempt 1 completed",
              "session construction exceeded 60000ms",
            ],
          },
        },
    ])

    expect(routed.coverageGaps).toEqual([
      {
        stage: "finders",
        lens: "fixture-lens",
        reason: "session construction exceeded 60000ms",
      },
    ])
  })
})
