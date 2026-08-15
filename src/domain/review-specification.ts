import * as Schema from "effect/Schema"

// One retained requirement document with document-level provenance: enough to
// cite where the text came from. `role` labels the document's standing —
// today only the caller-provided addendum exists; fetched Slice and parent
// documents arrive with the Specification Sources (issue #70).
export const SpecificationDocument = Schema.Struct({
  role: Schema.Literals(["caller-addendum"]),
  provenance: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})
export type SpecificationDocument = typeof SpecificationDocument.Type

// The source-neutral requirement material used to judge one ReviewTarget,
// frozen in the ReviewPlan exactly once at submission (CONTEXT.md). Resume
// consumes the frozen value and never re-reads issues, comments, or files.
export const ReviewSpecification = Schema.Struct({
  documents: Schema.NonEmptyArray(SpecificationDocument),
})
export type ReviewSpecification = typeof ReviewSpecification.Type
