import * as Schema from "effect/Schema"

// Shared core of every Candidate: identity, lens, location, summary
// (CONTEXT.md). `line` may be absent on whole-change findings.
const candidateCore = {
  id: Schema.NonEmptyString,
  lens: Schema.NonEmptyString,
  file: Schema.NonEmptyString,
  line: Schema.optionalKey(Schema.Int),
  summary: Schema.NonEmptyString,
}

// A Candidate self-classifies at emit time by the presence of a
// failure_scenario (ADR 0004): present → BugClaim bound for Pool →
// Verification; absent → Observation bound for Judgment.
export const Candidate = Schema.TaggedUnion({
  BugClaim: {
    ...candidateCore,
    // Concrete inputs or state under which the code does the wrong thing.
    // Creates an obligation for Verification to attempt refutation.
    failureScenario: Schema.NonEmptyString,
  },
  Observation: candidateCore,
})
export type Candidate = typeof Candidate.Type

export const BugClaim = Candidate.cases.BugClaim
export type BugClaim = typeof BugClaim.Type

export const Observation = Candidate.cases.Observation
export type Observation = typeof Observation.Type
