import { describe, expect, it } from "@effect/vitest"
import type { SpecificationComment } from "../domain/review-specification.ts"
import {
  COMMENT_BUDGET_CHARACTERS,
  trimCommentBudget,
} from "./comment-budget.ts"

const comment = (
  createdAt: string,
  text: string,
  id = createdAt,
): SpecificationComment => ({
  provenance: `https://github.com/example/repo/issues/1#issuecomment-${id}`,
  createdAt,
  text,
})

describe("trimCommentBudget", () => {
  it("retains every comment at and below the 20k bound", () => {
    const below = comment("2026-01-01T00:00:00Z", "a".repeat(COMMENT_BUDGET_CHARACTERS - 1))
    const at = comment("2026-01-02T00:00:00Z", "b".repeat(COMMENT_BUDGET_CHARACTERS))
    expect(trimCommentBudget([below])).toEqual({
      comments: [below],
      commentOmission: undefined,
    })
    expect(trimCommentBudget([at])).toEqual({
      comments: [at],
      commentOmission: undefined,
    })
  })

  it("drops earliest whole comments across threads until the remainder fits", () => {
    const oldest = comment("2026-01-01T00:00:00Z", "a".repeat(8_000), "old")
    const middle = comment("2026-01-02T00:00:00Z", "b".repeat(8_000), "mid")
    const newest = comment("2026-01-03T00:00:00Z", "c".repeat(8_000), "new")
    const trimmed = trimCommentBudget([newest, oldest, middle])

    expect(trimmed.comments).toEqual([middle, newest])
    expect(trimmed.commentOmission).toEqual({
      droppedCount: 1,
      droppedCharacters: 8_000,
      cutoff: "2026-01-02T00:00:00Z",
    })
  })

  it("never splits a comment and drops a single comment that exceeds the bound", () => {
    const oversized = comment("2026-01-01T00:00:00Z", "x".repeat(COMMENT_BUDGET_CHARACTERS + 1))
    const trimmed = trimCommentBudget([oversized])
    expect(trimmed.comments).toEqual([])
    expect(trimmed.commentOmission).toEqual({
      droppedCount: 1,
      droppedCharacters: COMMENT_BUDGET_CHARACTERS + 1,
      cutoff: "2026-01-01T00:00:00Z",
    })
  })
})
