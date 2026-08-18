import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export const IssueState = Schema.Literals(["OPEN", "CLOSED"])
export type IssueState = typeof IssueState.Type

export const SpecificationDocumentRole = Schema.Literals([
  "caller-addendum",
  "parent",
  "slice",
])
export type SpecificationDocumentRole = typeof SpecificationDocumentRole.Type

// One retained requirement document with document-level provenance: enough to
// cite where the text came from. `role` labels the document's standing.
export const SpecificationDocument = Schema.Struct({
  role: SpecificationDocumentRole,
  provenance: Schema.NonEmptyString,
  // Issue bodies are retained verbatim and may be empty; a Caller Addendum is
  // rejected at load when empty, so it never arrives here blank.
  text: Schema.String,
  title: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(IssueState),
})
export type SpecificationDocument = typeof SpecificationDocument.Type

export const SpecificationComment = Schema.Struct({
  provenance: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
  text: Schema.String,
})
export type SpecificationComment = typeof SpecificationComment.Type

// Recorded when admitted comments exceeded the aggregate bound: what was
// dropped, how much, and the cutoff (CONTEXT.md).
export const CommentOmission = Schema.Struct({
  droppedCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  droppedCharacters: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cutoff: Schema.NonEmptyString,
})
export type CommentOmission = typeof CommentOmission.Type

// The source-neutral requirement material used to judge one ReviewTarget,
// frozen in the ReviewPlan exactly once at submission (CONTEXT.md). Resume
// consumes the frozen value and never re-reads issues, comments, or files.
export const ReviewSpecification = Schema.Struct({
  documents: Schema.NonEmptyArray(SpecificationDocument),
  comments: Schema.Array(SpecificationComment).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed([])),
  ),
  commentOmission: Schema.optionalKey(CommentOmission),
})
export type ReviewSpecification = typeof ReviewSpecification.Type
