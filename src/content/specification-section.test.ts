import { describe, expect, it } from "@effect/vitest"
import { ReviewSpecification } from "../domain/review-specification.ts"
import { renderSpecificationSection } from "./specification-section.ts"

describe("renderSpecificationSection", () => {
  it("labels fetched documents and the caller addendum without replacing either", () => {
    const section = renderSpecificationSection(
      ReviewSpecification.make({
        documents: [
          {
            role: "parent",
            provenance: "https://github.com/example/repo/issues/70",
            text: "parent body",
            title: "parent spec",
            state: "OPEN",
          },
          {
            role: "slice",
            provenance: "https://github.com/example/repo/issues/74",
            text: "slice body",
            title: "github source",
            state: "OPEN",
          },
          {
            role: "caller-addendum",
            provenance: "/tmp/addendum.md",
            text: "caller note",
          },
        ],
        comments: [
          {
            provenance: "https://github.com/example/repo/issues/74#issuecomment-1",
            createdAt: "2026-01-02T00:00:00Z",
            text: "keep this",
          },
        ],
        commentOmission: {
          droppedCount: 1,
          droppedCharacters: 12,
          cutoff: "2026-01-02T00:00:00Z",
        },
      }),
    )

    expect(section.indexOf("parent body")).toBeLessThan(section.indexOf("slice body"))
    expect(section.indexOf("slice body")).toBeLessThan(section.indexOf("caller note"))
    expect(section).toContain(
      "### Parent: parent spec (https://github.com/example/repo/issues/70) [OPEN]",
    )
    expect(section).toContain(
      "### Current Slice: github source (https://github.com/example/repo/issues/74) [OPEN]",
    )
    expect(section).toContain(
      "### Caller Addendum (caller-provided: /tmp/addendum.md)",
    )
    expect(section).toContain(
      "Dropped 1 earliest comments (12 characters). Cutoff: 2026-01-02T00:00:00Z.",
    )
    expect(section).toContain("keep this")
  })
})
