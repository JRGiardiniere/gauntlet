import * as Schema from "effect/Schema"
import { Seat } from "./recipe.ts"
import { ReviewTarget } from "./review-target.ts"

export const LensName = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
)
export type LensName = typeof LensName.Type

export const DEFAULT_CANDIDATE_CAP = 6
export const SUBJECTIVE_CANDIDATE_CAP = DEFAULT_CANDIDATE_CAP * 2

export const candidateCapForLens = (lensName: LensName): number =>
  lensName === "subjective"
    ? SUBJECTIVE_CANDIDATE_CAP
    : DEFAULT_CANDIDATE_CAP

// A lens frozen into the plan at submission: prompt text travels with the
// run so resume replays the exact tail (ADR 0004). Version identity is the
// stored text itself, never a separately maintained hash.
export const FrozenLens = Schema.Struct({
  name: LensName,
  promptText: Schema.NonEmptyString,
  // The resolved finder seat belongs to this frozen invocation. A lens
  // override therefore survives resume without ambient adapter configuration.
  seat: Seat,
  // Per-lens candidate cap, stated in the prompt and enforced by truncation
  // (docs/spec/pipeline-shape.md). The shared default is applied at freeze.
  candidateCap: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type FrozenLens = typeof FrozenLens.Type

// The fully resolved instructions governing one review — semantics-and-spend
// fields only — persisted once at submission; resume reuses completed paid
// work when the target is unchanged, under the currently installed code
// (CONTEXT.md). Delivery destination is not part of the plan, and neither
// is any budget or cost field (ADR 0006).
export const ReviewPlan = Schema.Struct({
  runId: Schema.NonEmptyString,
  // The diff is stored exactly once, inside the target (ADR 0006).
  target: ReviewTarget,
  // Resolved from the named recipe at submission. Absent seats mean the
  // corresponding stage runs no invocations — the walking skeleton freezes
  // an entirely seatless plan. Finder seats are not stage state: each frozen
  // lens carries its own class-resolved seat, and a mixed standard/interpretive
  // run has no single Finder seat to record.
  recipeName: Schema.optionalKey(Schema.NonEmptyString),
  seats: Schema.Struct({
    pool: Schema.optionalKey(Seat),
    verification: Schema.optionalKey(Seat),
    judgment: Schema.optionalKey(Seat),
  }),
  lenses: Schema.Array(FrozenLens),
})
export type ReviewPlan = typeof ReviewPlan.Type
