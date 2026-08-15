import type {
  ReviewSpecification,
  SpecificationDocument,
} from "../domain/review-specification.ts"

const documentHeading = (document: SpecificationDocument): string => {
  switch (document.role) {
    case "caller-addendum":
      return `### Caller Addendum (caller-provided: ${document.provenance})`
  }
}

// Rendered only when a ReviewSpecification exists — a run without one carries
// no absence text in any prompt (issue #73). The section sits after the
// shared/stable context and before the invocation-specific assignment.
export const renderSpecificationSection = (
  specification: ReviewSpecification,
): string =>
  [
    "## Review Specification",
    "The requirement material behind this change — what the author was asked to deliver. Use it to judge intent and scope; the current obligations it states define what is owed now.",
    ...specification.documents.flatMap((document) => [
      documentHeading(document),
      document.text.trim(),
    ]),
  ].join("\n\n")
