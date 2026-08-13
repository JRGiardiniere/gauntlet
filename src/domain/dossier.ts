import * as Schema from "effect/Schema"
import { BugClaim, Observation } from "./candidate.ts"
import { Judgment } from "./judgment.ts"
import { TargetIdentity } from "./review-target.ts"
import { StageName } from "./stage.ts"
import { Verdict } from "./verdict.ts"

// A lens or stage whose work is missing from the Dossier — visible data,
// distinct from diagnostics and from failure (CONTEXT.md).
export const CoverageGap = Schema.Struct({
  stage: StageName,
  lens: Schema.optionalKey(Schema.NonEmptyString),
  reason: Schema.NonEmptyString,
})
export type CoverageGap = typeof CoverageGap.Type

export const EvaluatedBugClaim = Schema.Struct({
  candidate: BugClaim,
  // The Pool cluster this claim was verified in. Cluster-mates are duplicate
  // claims of one another and share a single verdict; presentation renders a
  // cluster as one finding while every mate stays here.
  cluster: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  verdict: Verdict,
})
export type EvaluatedBugClaim = typeof EvaluatedBugClaim.Type

export const JudgedObservation = Schema.Struct({
  candidate: Observation,
  judgment: Judgment,
})
export type JudgedObservation = typeof JudgedObservation.Type

// The canonical, complete semantic result of one review (CONTEXT.md).
// Refutations live in bugClaims as Refuted verdicts and drops in
// observations as Dropped judgments — every candidate is accounted for
// exactly once; presentation partitions, never filters silently.
export const Dossier = Schema.Struct({
  runId: Schema.NonEmptyString,
  target: TargetIdentity,
  bugClaims: Schema.Array(EvaluatedBugClaim),
  observations: Schema.Array(JudgedObservation),
  coverageGaps: Schema.Array(CoverageGap),
})
export type Dossier = typeof Dossier.Type
