import { describe, expect, it } from "@effect/vitest"
import { ReviewSpecification } from "../domain/review-specification.ts"
import { combineReviewSpecifications } from "./combine.ts"

describe("combineReviewSpecifications", () => {
  const fetched = ReviewSpecification.make({
    documents: [{
      role: "slice",
      provenance: "https://github.com/example/repo/issues/74",
      text: "fetched",
      title: "slice",
      state: "OPEN",
    }],
    comments: [{
      provenance: "https://github.com/example/repo/issues/74#issuecomment-1",
      createdAt: "2026-01-01T00:00:00Z",
      text: "kept",
    }],
  })
  const addendum = ReviewSpecification.make({
    documents: [{
      role: "caller-addendum",
      provenance: "/tmp/addendum.md",
      text: "caller",
    }],
    comments: [],
  })

  it("appends the addendum after fetched material and keeps fetched comments", () => {
    const combined = combineReviewSpecifications(fetched, addendum)
    expect(combined?.documents.map((document) => document.role)).toEqual([
      "slice",
      "caller-addendum",
    ])
    expect(combined?.comments).toEqual(fetched.comments)
  })

  it("returns the addendum alone when nothing was fetched", () => {
    expect(combineReviewSpecifications(undefined, addendum)).toEqual(addendum)
  })
})
