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
          verdict: Verdict.cases.Confirmed.make({
            reviewPriority: "P2",
            evidence: "reproduced",
          }),
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

    expect(dossier.findings).toHaveLength(1)
    expect(dossier.findings[0]).toMatchObject({
      _tag: "Confirmed",
      testSuggestion: { tests: ["src/fixture.test.ts"] },
    })
    expect(dossier.unresolved).toHaveLength(0)
    expect(dossier.rejected.refutedClaims).toHaveLength(0)
    expect(dossier.rejected.droppedObservations).toHaveLength(1)
    expect(dossier.coverageGaps.map(({ stage }) => stage)).toEqual([
      "finders",
      "verification",
      "judgment",
    ])
  })

  it("orders the actionable queue by priority and Confirmed before Judgment", () => {
    const priorities = ["P3", "P1", "P2"] as const
    const bugClaims = priorities.map((reviewPriority, index) => ({
      candidate: Candidate.cases.BugClaim.make({
        id: `fixture/claim-${String(index + 1)}`,
        lens: "fixture",
        file: "src/fixture.ts",
        summary: `${reviewPriority} claim`,
        failureScenario: "input fails",
      }),
      cluster: index + 1,
      verdict: Verdict.cases.Confirmed.make({
        reviewPriority,
        evidence: "reproduced",
      }),
    }))
    const observations = priorities.map((reviewPriority, index) => ({
      candidate: Candidate.cases.Observation.make({
        id: `fixture/observation-${String(index + 1)}`,
        lens: "fixture",
        file: "src/fixture.ts",
        summary: `${reviewPriority} observation`,
      }),
      judgment: Judgment.cases.Kept.make({
        reviewPriority,
        reason: "checked the call sites",
        goodFind: true,
        cleanlyExplained: true,
        mergedCandidateIds: [],
      }),
    }))

    const dossier = assembleDossier({
      plan,
      finderCoverageGaps: [],
      bugClaimPath: {
        bugClaims,
        testSuggestions: [],
        coverageGaps: [],
      },
      judgmentPath: { observations, coverageGaps: [] },
    })

    expect(dossier.findings.map((entry) => [
      entry._tag,
      entry._tag === "Confirmed"
        ? entry.verdict.reviewPriority
        : entry.judgment.reviewPriority,
    ])).toEqual([
      ["Confirmed", "P1"],
      ["Judgment", "P1"],
      ["Confirmed", "P2"],
      ["Judgment", "P2"],
      ["Confirmed", "P3"],
      ["Judgment", "P3"],
    ])
  })
})
