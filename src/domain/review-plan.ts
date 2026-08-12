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

// A lens frozen into the plan at submission: prompt text and content hash
// travel with the run so runs are comparable exactly when hashes match
// (ADR 0004). Version identity is derived, never maintained.
export const FrozenLens = Schema.Struct({
  name: LensName,
  promptText: Schema.NonEmptyString,
  contentHash: Schema.NonEmptyString,
  // The resolved finder seat belongs to this frozen invocation. A lens
  // override therefore survives resume without ambient adapter configuration.
  seat: Seat,
  // Applicability is resolved at submission; retained here so a spec-aware
  // prompt can append the plan's frozen spec text after the lens tail.
  needsSpec: Schema.Boolean,
  // Display-only grouping for listings and report headers, never routing.
  category: Schema.optionalKey(Schema.NonEmptyString),
  // Per-lens candidate cap, stated in the prompt and enforced by truncation
  // (docs/spec/pipeline-shape.md). The shared default is applied at freeze.
  candidateCap: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
})
export type FrozenLens = typeof FrozenLens.Type

// The fully resolved instructions governing one review — semantics-and-spend
// fields only — persisted once at submission so a resumed Run is the same
// review (CONTEXT.md). Delivery destination is not part of the plan, and
// neither is any budget or cost field (ADR 0006).
export const ReviewPlan = Schema.Struct({
  runId: Schema.NonEmptyString,
  createdAt: Schema.NonEmptyString,
  // The diff is stored exactly once, inside the target (ADR 0006).
  target: ReviewTarget,
  // Optional originating intent is frozen with the review. Needs-spec lenses
  // are excluded during planning when it is absent.
  specText: Schema.optionalKey(Schema.NonEmptyString),
  // Resolved from the named recipe at submission. Absent seats mean the
  // corresponding stage runs no invocations — the walking skeleton freezes
  // an entirely seatless plan. Finder seats are not stage state: each frozen
  // lens carries its own class-resolved seat, and a mixed standard/deep run
  // has no single Finder seat to record.
  recipeName: Schema.optionalKey(Schema.NonEmptyString),
  seats: Schema.Struct({
    pool: Schema.optionalKey(Seat),
    verification: Schema.optionalKey(Seat),
    judgment: Schema.optionalKey(Seat),
  }),
  lenses: Schema.Array(FrozenLens),
})
export type ReviewPlan = typeof ReviewPlan.Type
