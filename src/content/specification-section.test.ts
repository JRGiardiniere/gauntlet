import { describe, expect, it } from "@effect/vitest"
import { ReviewSpecification } from "../domain/review-specification.ts"
import { renderSpecificationSection } from "./specification-section.ts"

describe("renderSpecificationSection", () => {
  it("labels the caller addendum with its file", () => {
    const section = renderSpecificationSection(
      ReviewSpecification.make({ provenance: "/tmp/addendum.md", text: "caller note\n" }),
    )

    expect(section).toContain("## Review Specification")
    expect(section).toContain("### Caller Addendum (caller-provided: /tmp/addendum.md)\n\ncaller note")
  })
})
