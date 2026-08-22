import * as Schema from "effect/Schema"

export const ReviewPriority = Schema.Literals(["P1", "P2", "P3"])
export type ReviewPriority = typeof ReviewPriority.Type

// What Verification attaches to a BugClaim (CONTEXT.md). Plausible is a
// first-class verdict — a BugClaim whose verifier never returned lands here
// with no reviewPriority or evidence, never as an absence.
export const Verdict = Schema.TaggedUnion({
  Confirmed: {
    reviewPriority: ReviewPriority,
    // One line: the inputs/state and the wrong output.
    evidence: Schema.NonEmptyString,
  },
  Refuted: {
    // One line: what refutes the claimed failure scenario.
    evidence: Schema.NonEmptyString,
  },
  Plausible: {
    reviewPriority: Schema.optionalKey(ReviewPriority),
    evidence: Schema.optionalKey(Schema.NonEmptyString),
  },
})
export type Verdict = typeof Verdict.Type
