import { describe, expect, it } from "@effect/vitest"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import { Candidate } from "../domain/candidate.ts"
import { FrozenLens } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { formatCandidateLine } from "./candidate-line.ts"
import { assembleFinderPrompt } from "./finder-prompt.ts"

const target = ReviewTarget.cases.WorkingTree.make({
  repoRoot: "/fixture/repo",
  headCommit: "abcdef",
  changedFiles: ["README.md"],
  diff: "@@ -1 +1 @@\n context\n ```\n+changed",
  untrackedFiles: [],
  warnings: [],
})

const reviewRoot = "/fixture/review-worktree"

describe("finder and candidate prompt text", () => {
  it("formats both Candidate kinds through one line format", () => {
    expect(formatCandidateLine({
      index: 1,
      candidate: Candidate.cases.BugClaim.make({
        id: "fixture/1",
        lens: "fixture",
        file: "README.md",
        line: 2,
        summary: "the changed example breaks",
        failureScenario: "the fenced example reaches the new branch",
      }),
    })).toBe(
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

  it.effect("frames an embedded Markdown fence safely in the finder prompt", () =>
    Effect.gen(function* () {
      const finder = yield* assembleFinderPrompt(
        {
          sharedPromptTemplate:
            "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}\n{{WORKSPACE_TOOLS}}\ncap={{MAX_PER_LENS}}",
          workspaceTools: "tools at {{REPO_ROOT}}",
        },
        target,
        reviewRoot,
        FrozenLens.make({
          name: "fixture",
          promptText: "fixture lens",
          seat: "fixture/model:low",
          candidateCap: 6,
        }),
        undefined,
      )

      expect(finder).toContain(`tools at ${reviewRoot}`)
      expect(finder).not.toContain(target.repoRoot)
      expect(finder).toContain("````diff\n")
      expect(finder).toContain("\n ```\n")
      expect(finder).toContain("\n````")
    }))

  it.effect("names a touched bun.lock instead of inlining its diff", () =>
    Effect.gen(function* () {
      const diff = Array.join([
        "diff --git a/src/app.ts b/src/app.ts",
        "--- a/src/app.ts",
        "+++ b/src/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/bun.lock b/bun.lock",
        "--- a/bun.lock",
        "+++ b/bun.lock",
        "@@ -1 +1 @@",
        `-"effect": "4.0.0"`,
        `+"effect": "4.1.0"`,
      ], "\n")

      const finder = yield* assembleFinderPrompt(
        { sharedPromptTemplate: "{{CHANGED_FILES}}\n{{DIFF_SECTION}}\n{{REPO_ROOT}}{{WORKSPACE_TOOLS}}{{MAX_PER_LENS}}", workspaceTools: "{{REPO_ROOT}}" },
        ReviewTarget.cases.WorkingTree.make({ ...target, changedFiles: ["src/app.ts", "bun.lock"], diff }),
        reviewRoot,
        FrozenLens.make({ name: "fixture", promptText: "fixture lens", seat: "fixture/model:low", candidateCap: 6 }),
        undefined,
      )

      expect(finder).toContain("+new")
      expect(finder).not.toContain("4.1.0")
      expect(finder).toContain("diff --git a/bun.lock b/bun.lock\n")
      expect(finder).toContain("with their changed lines left out: bun.lock.")
    }))
})
