import { describe, expect, it } from "@effect/vitest"
import {
  GOVERNING_STANDARDS_HEADING,
  selectRunnableFinders,
} from "./finder-selection.ts"
import { FrozenLens, ReviewPlan } from "./review-plan.ts"
import { ReviewTarget } from "./review-target.ts"

const lens = (name: string, promptText: string) =>
  FrozenLens.make({
    name,
    promptText,
    seat: "fixture/fixture-model:low",
    candidateCap: 6,
  })

const planWith = (lenses: ReadonlyArray<FrozenLens>) =>
  ReviewPlan.make({
    runId: "run-fixture",
    target: ReviewTarget.cases.WorkingTree.make({
      repoRoot: "/fixture/repo",
      headCommit: "abcdef0123456789",
      changedFiles: ["alpha.ts"],
      diff: "+needle",
      untrackedFiles: [],
      warnings: [],
    }),
    seats: {},
    lenses,
  })

describe("finder selection", () => {
  it("skips each intrinsic lens identity with its own reason, keeping it in the plan", () => {
    const selection = selectRunnableFinders(planWith([
      lens("fixture-review", "fixture tail"),
      lens("spec-conformance", "specification tail"),
      lens("standards", "standards tail with no governing block"),
    ]))
    expect(selection.runnable.map(({ name }) => name)).toEqual([
      "fixture-review",
    ])
    expect(
      selection.skipped.map(({ lens, reason }) => [lens.name, reason]),
    ).toEqual([
      ["spec-conformance", "no ReviewSpecification"],
      ["standards", "no Standards Manifest"],
    ])
  })

  it("runs standards when its frozen prompt carries the Governing standards block", () => {
    const selection = selectRunnableFinders(planWith([
      lens(
        "standards",
        `standards tail\n\n${GOVERNING_STANDARDS_HEADING}\n\n### CLAUDE.md\n\nrule text`,
      ),
    ]))
    expect(selection.runnable.map(({ name }) => name)).toEqual(["standards"])
    expect(selection.skipped).toEqual([])
  })
})
