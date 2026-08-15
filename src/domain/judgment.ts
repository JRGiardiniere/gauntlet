import * as Schema from "effect/Schema"
import { ReviewPriority } from "./verdict.ts"

// What the judge attaches to an Observation (CONTEXT.md). Undecided is
// first-class — an Observation the judge said nothing about lands here,
// never silently dropped.
export const Judgment = Schema.TaggedUnion({
  Kept: {
    reviewPriority: ReviewPriority,
    // Why it is warranted AND what was checked in the tree to confirm it.
    reason: Schema.NonEmptyString,
    // The Observation path's only quality record (docs/spec/emit-tools.md):
    // deliberately unscored against any answer key.
    goodFind: Schema.Boolean,
    cleanlyExplained: Schema.Boolean,
    qualityNote: Schema.optionalKey(Schema.NonEmptyString),
    // Ids of duplicate candidates folded into this kept one.
    mergedCandidateIds: Schema.Array(Schema.NonEmptyString),
  },
  Dropped: {
    reason: Schema.NonEmptyString,
  },
  Undecided: {},
})
export type Judgment = typeof Judgment.Type
