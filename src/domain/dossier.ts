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

// Verification's optional advice to run named existing repository tests
// (CONTEXT.md). One per recommending Pool cluster, associated with the stable
// id of every cluster-mate — never once per duplicate claim. Downstream
// advice only: it never changes a Verdict, and Gauntlet never runs the tests.
export const TestSuggestion = Schema.Struct({
  tests: Schema.NonEmptyArray(Schema.NonEmptyString),
  reason: Schema.NonEmptyString,
  bugClaimIds: Schema.NonEmptyArray(Schema.NonEmptyString),
})
export type TestSuggestion = typeof TestSuggestion.Type

const ClusteredBugClaim = {
  cluster: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  bugClaims: Schema.NonEmptyArray(BugClaim),
}

const SuggestedBugClaim = {
  ...ClusteredBugClaim,
  testSuggestion: Schema.optionalKey(TestSuggestion),
}

// The machine Dossier uses the same reader-facing hierarchy as dossier.md.
// Assembly orders this work queue by Review Priority and then by domain path.
export const DossierFinding = Schema.TaggedUnion({
  Confirmed: {
    ...SuggestedBugClaim,
    verdict: Verdict.cases.Confirmed,
  },
  Judgment: {
    candidate: Observation,
    judgment: Judgment.cases.Kept,
  },
})
export type DossierFinding = typeof DossierFinding.Type

export const DossierUnresolved = Schema.TaggedUnion({
  Plausible: {
    ...SuggestedBugClaim,
    verdict: Verdict.cases.Plausible,
  },
  Undecided: {
    candidate: Observation,
    judgment: Judgment.cases.Undecided,
  },
})
export type DossierUnresolved = typeof DossierUnresolved.Type

export const RefutedClaim = Schema.TaggedStruct("Refuted", {
  ...ClusteredBugClaim,
  verdict: Verdict.cases.Refuted,
})
export type RefutedClaim = typeof RefutedClaim.Type

export const DroppedObservation = Schema.TaggedStruct("Dropped", {
  candidate: Observation,
  judgment: Judgment.cases.Dropped,
})
export type DroppedObservation = typeof DroppedObservation.Type

// The canonical, complete semantic result of one review (CONTEXT.md).
// Every evaluated cluster and judged observation is accounted for exactly
// once in the hierarchy. Operational run notes deliberately live elsewhere.
export const Dossier = Schema.Struct({
  runId: Schema.NonEmptyString,
  target: TargetIdentity,
  findings: Schema.Array(DossierFinding),
  unresolved: Schema.Array(DossierUnresolved),
  rejected: Schema.Struct({
    refutedClaims: Schema.Array(RefutedClaim),
    droppedObservations: Schema.Array(DroppedObservation),
  }),
  coverageGaps: Schema.Array(CoverageGap),
})
export type Dossier = typeof Dossier.Type
