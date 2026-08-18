import type { FrozenLens, ReviewPlan } from "./review-plan.ts"

const SPEC_CONFORMANCE_LENS = "spec-conformance"

export interface FinderSelection {
  readonly runnable: ReadonlyArray<FrozenLens>
  readonly skipped: ReadonlyArray<FrozenLens>
}

// spec-conformance is the only Lens whose assignment is meaningless without
// a ReviewSpecification. Keep it frozen in the selected plan, but do not turn
// its inapplicability into an invocation or a coverage gap.
export const selectRunnableFinders = (plan: ReviewPlan): FinderSelection => {
  const runnable: Array<FrozenLens> = []
  const skipped: Array<FrozenLens> = []
  for (const lens of plan.lenses) {
    if (
      lens.name === SPEC_CONFORMANCE_LENS &&
      plan.specification === undefined
    ) {
      skipped.push(lens)
    } else {
      runnable.push(lens)
    }
  }
  return { runnable, skipped }
}
