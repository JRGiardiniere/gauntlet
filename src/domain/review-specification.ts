import * as Schema from "effect/Schema"

// The requirement material used to judge one ReviewTarget: the Caller
// Addendum's Markdown, frozen in the ReviewPlan exactly once at submission
// (GLOSSARY.md). Later stages consume the frozen value and never re-read the
// file. `provenance` is the file's resolved path.
export const ReviewSpecification = Schema.Struct({
  provenance: Schema.NonEmptyString,
  text: Schema.NonEmptyString,
})

export type ReviewSpecification = typeof ReviewSpecification.Type
