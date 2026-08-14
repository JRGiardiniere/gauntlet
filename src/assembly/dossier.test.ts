import { describe, expect, it } from "@effect/vitest"
import { Candidate } from "../domain/candidate.ts"
import { Judgment } from "../domain/judgment.ts"
import { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"
import { assembleDossier } from "./dossier.ts"

const target = ReviewTarget.cases.WorkingTree.make({
  repoRoot: "/fixture",
  headCommit: "abcdef0",
  changedFiles: ["src/fixture.ts"],
  diff: "+change",
  untrackedFiles: [],
  warnings: [],
})

const plan = ReviewPlan.make({
  runId: "run-fixture",
  target,
  seats: {},
  lenses: [
    FrozenLens.make({
      name: "fixture",
      promptText: "fixture prompt",
      seat: "fixture/model:low",
      candidateCap: 6,
    }),
  ],
})

describe("Dossier Assembly", () => {
  it("joins every semantic partition and every coverage gap without filtering", () => {
    const bugClaim = Candidate.cases.BugClaim.make({
      id: "fixture/1",
      lens: "fixture",
      file: "src/fixture.ts",
      summary: "claim",
      failureScenario: "input fails",
    })
    const observation = Candidate.cases.Observation.make({
      id: "fixture/2",
      lens: "fixture",
      file: "src/fixture.ts",
      summary: "observation",
    })

    const dossier = assembleDossier({
      plan,
      finderCoverageGaps: [{
        stage: "finders",
        lens: "fixture",
        reason: "finder coverage gap",
      }],
      bugClaimPath: {
        bugClaims: [{
          candidate: bugClaim,
          cluster: 1,
          verdict: Verdict.cases.Refuted.make({ evidence: "guarded" }),
        }],
        testSuggestions: [{
          tests: ["src/fixture.test.ts"],
          reason: "covers the failing input",
          bugClaimIds: ["fixture/1"],
        }],
        coverageGaps: [{ stage: "verification", reason: "verifier gap" }],
      },
      judgmentPath: {
        observations: [{
          candidate: observation,
          judgment: Judgment.cases.Dropped.make({ reason: "taste, not cost" }),
        }],
        coverageGaps: [{ stage: "judgment", reason: "judge gap" }],
      },
    })

    expect(dossier.bugClaims).toHaveLength(1)
    expect(dossier.testSuggestions).toHaveLength(1)
    expect(dossier.observations).toHaveLength(1)
    expect(dossier.coverageGaps.map(({ stage }) => stage)).toEqual([
      "finders",
      "verification",
      "judgment",
    ])
  })
})
