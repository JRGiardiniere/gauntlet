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

const FINDER_INVOCATION_PREFIX = "finder-"

// finder-stage.json names each Finder only by this key.
export const lensOfFinderInvocationKey = (invocationKey: string): string =>
  invocationKey.startsWith(FINDER_INVOCATION_PREFIX)
    ? invocationKey.slice(FINDER_INVOCATION_PREFIX.length)
    : invocationKey

export const finderInvocationsInPlan = (
  plan: ReviewPlan,
): ReadonlyArray<PlannedFinderInvocation> =>
  Array.map(selectRunnableFinders(plan).runnable, (lens) => ({
    invocationKey: `${FINDER_INVOCATION_PREFIX}${lens.name}`,
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
