import * as Schema from "effect/Schema"

export const Severity = Schema.Literals(["P1", "P2", "P3"])
export type Severity = typeof Severity.Type

// What Verification attaches to a BugClaim (CONTEXT.md). Unverified is a
// first-class verdict — a BugClaim whose verifier never returned lands here
// with no severity or evidence, never as an absence.
export const Verdict = Schema.TaggedUnion({
  Confirmed: {
    severity: Severity,
    // One line: the inputs/state and the wrong output.
    evidence: Schema.NonEmptyString,
  },
  Refuted: {
    // One line: what refutes the claimed failure scenario.
    evidence: Schema.NonEmptyString,
  },
  Unverified: {
    severity: Schema.optionalKey(Severity),
    evidence: Schema.optionalKey(Schema.NonEmptyString),
  },
})
export type Verdict = typeof Verdict.Type
