import * as Array from "effect/Array"
import * as Record from "effect/Record"
import {
  resolveFinderContext,
  type ResolvedFinderContext,
} from "../content/finder-prompt.ts"
import { selectRunnableFinders } from "../domain/finder-selection.ts"
import type { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import type { Seat } from "../domain/recipe.ts"

export interface PlannedFinderInvocation {
  readonly invocationKey: string
  readonly lens: FrozenLens
  readonly seat: Seat
  readonly context: ResolvedFinderContext
}

export const finderInvocationsInPlan = (
  plan: ReviewPlan,
): ReadonlyArray<PlannedFinderInvocation> =>
  selectRunnableFinders(plan).runnable.map((lens) => ({
    invocationKey: `finder-${lens.name}`,
    lens,
    seat: lens.seat,
    context: resolveFinderContext(lens, plan.specification),
  }))

export const finderPartitionsInPlan = (
  plan: ReviewPlan,
): ReadonlyArray<Array.NonEmptyArray<PlannedFinderInvocation>> =>
  Record.values(
    Array.groupBy(
      finderInvocationsInPlan(plan),
      ({ context, seat }) => `${seat}\u0000${context.key}`,
    ),
  )
