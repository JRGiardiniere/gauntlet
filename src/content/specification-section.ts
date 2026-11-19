import * as Array from "effect/Array"
import type { ReviewSpecification } from "../domain/review-specification.ts"

// Rendered only when a ReviewSpecification exists — a run without one carries
// no absence text in any prompt (issue #73). The section sits after the
// shared/stable context and before the invocation-specific assignment.
export const renderSpecificationSection = (
  specification: ReviewSpecification,
): string =>
  Array.join([
    "## Review Specification",
    "The requirement material behind this change — what the author was asked to deliver. Use it to judge intent and scope; the current obligations it states define what is owed now.",
    `### Caller Addendum (caller-provided: ${specification.provenance})`,
    specification.text.trim(),
  ], "\n\n")
