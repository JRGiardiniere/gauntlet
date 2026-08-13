import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Candidate } from "../domain/candidate.ts"
import { FrozenLens } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { formatCandidateLine } from "./candidate-line.ts"
import {
  assembleVerifierPrompt,
  type EvaluationPromptTemplates,
} from "./evaluation-prompt.ts"
import { assembleFinderPrompt } from "./finder-prompt.ts"

const target = ReviewTarget.cases.WorkingTree.make({
  repoRoot: "/fixture/repo",
  headCommit: "abcdef",
  changedFiles: ["README.md"],
  diff: "@@ -1 +1 @@\n context\n ```\n+changed",
  warnings: [],
})
const reviewRoot = "/fixture/review-worktree"

const bugClaim = Candidate.cases.BugClaim.make({
  id: "fixture/1",
  lens: "fixture",
  file: "README.md",
  line: 2,
  summary: "the changed example breaks",
  failureScenario: "the fenced example reaches the new branch",
})

describe("evaluation prompts", () => {
  it("formats both Candidate kinds through one line format", () => {
    expect(formatCandidateLine({ index: 1, candidate: bugClaim })).toBe(
      "[1] (fixture) README.md:2 — the changed example breaks\n    claimed failure: the fenced example reaches the new branch",
    )
    expect(formatCandidateLine({
      index: 2,
      candidate: Candidate.cases.Observation.make({
        id: "fixture/2",
        lens: "fixture",
        file: "README.md",
        summary: "the name obscures the intent",
      }),
    })).toBe("[2] (fixture) README.md — the name obscures the intent")
  })

  it.effect("frames embedded Markdown fences safely in both prompt paths", () =>
    Effect.gen(function* () {
      const finder = yield* assembleFinderPrompt(
        "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}\ncap={{MAX_PER_LENS}}",
        target,
        reviewRoot,
        FrozenLens.make({
          name: "fixture",
          promptText: "fixture lens",
          contentHash: "fixture-hash",
          seat: "fixture/model:low",
          needsSpec: false,
          candidateCap: 6,
        }),
      )
      const templates: EvaluationPromptTemplates = {
        pool: "{{CANDIDATES}}",
        verifier: "{{SCOPE_BLOCK}}\n{{CLAIMS}}",
        stageScope:
          "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}\n{{INTENT_SECTION}}",
      }
      const verifier = yield* assembleVerifierPrompt(
        templates,
        target,
        reviewRoot,
        undefined,
        [{ index: 1, candidate: bugClaim }],
        [{ number: 1, indexes: [1], summary: bugClaim.summary }],
      )
      for (const prompt of [finder, verifier]) {
        expect(prompt).toContain(reviewRoot)
        expect(prompt).not.toContain(target.repoRoot)
        expect(prompt).toContain("````diff\n")
        expect(prompt).toContain("\n ```\n")
        expect(prompt).toContain("\n````")
      }
      expect(verifier).toContain(
        "judge the change on its own terms, and do not assume intent you cannot see",
      )
    }))
})
