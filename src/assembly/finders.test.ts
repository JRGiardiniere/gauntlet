import { describe, expect, it } from "@effect/vitest"
import { Termination } from "../domain/agent-outcome.ts"
import { FrozenLens } from "../domain/review-plan.ts"
import { enforceCandidateCap, routeFinderResults } from "./finders.ts"

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: 0,
  rawRows: [],
}

const fixtureLens = (candidateCap = 6) =>
  FrozenLens.make({
    name: "fixture-lens",
    promptText: "fixture tail",
    contentHash: "fixture-hash",
    seat: "fixture/fixture-model:low",
    needsSpec: false,
    candidateCap,
  })

describe("enforceCandidateCap", () => {
  it("truncates over-emitting finder output to the plan cap with a diagnostic", () => {
    const findings = globalThis.Array.from({ length: 8 }, (_, index) => ({
      file: "alpha.ts",
      summary: `candidate ${String(index + 1)}`,
    }))
    const capped = enforceCandidateCap(fixtureLens(6), {
      termination: Termination.cases.Completed.make({}),
      output: { findings },
      usage: emptyUsage,
      durationMillis: 1,
      diagnostics: ["prior diagnostic"],
    })

    expect(capped.output?.findings).toHaveLength(6)
    expect(capped.diagnostics).toEqual([
      "prior diagnostic",
      "finder fixture-lens emitted 8 candidates; retained the plan cap of 6",
    ])
  })

  it("leaves under-cap output unchanged", () => {
    const outcome = {
      termination: Termination.cases.Completed.make({}),
      output: {
        findings: [{ file: "alpha.ts", summary: "one candidate" }],
      },
      usage: emptyUsage,
      durationMillis: 1,
      diagnostics: [] as Array<string>,
    }
    expect(enforceCandidateCap(fixtureLens(6), outcome)).toBe(outcome)
  })
})

describe("finder assembly", () => {
  it("routes raw Candidates without provisional evaluation", () => {
    const routed = routeFinderResults([
      {
        lens: fixtureLens(),
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
          usage: emptyUsage,
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
    const routed = routeFinderResults([
      {
        lens: fixtureLens(),
        outcome: {
          termination: Termination.cases.FirstResponseTimeout.make({}),
          usage: emptyUsage,
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
