import { describe, expect, it } from "@effect/vitest"
import { Termination } from "../domain/agent-outcome.ts"
import { FrozenLens } from "../domain/review-plan.ts"
import { assembleFinderDossier } from "./finders.ts"

describe("finder assembly", () => {
  it("uses a timeout diagnostic to explain a missing finder output", () => {
    const lens = FrozenLens.make({
      name: "fixture-lens",
      promptText: "fixture tail",
      contentHash: "fixture-hash",
      seat: "fixture/fixture-model:low",
      needsSpec: false,
      candidateCap: 6,
    })
    const dossier = assembleFinderDossier(
      "fixture-run",
      {
        _tag: "WorkingTree",
        repoRoot: "/fixture/repo",
        headCommit: "abcdef",
      },
      [
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
      ],
    )

    expect(dossier.coverageGaps).toEqual([
      {
        stage: "finders",
        lens: "fixture-lens",
        reason: "session construction exceeded 60000ms",
      },
    ])
  })
})
