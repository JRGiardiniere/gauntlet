import type { FrozenLens, ReviewPlan } from "./review-plan.ts"

export const SPEC_CONFORMANCE_LENS_NAME = "spec-conformance"
export const STANDARDS_LENS_NAME = "standards"

// Submission appends the assembled Standards Manifest documents under this
// heading when it freezes the standards lens's prompt text (#110). Its
// presence in the frozen prompt is the whole skip signal — no plan field.
// The shipped lens body must never contain this heading on its own.
export const GOVERNING_STANDARDS_HEADING = "## Governing standards"

export interface SkippedFinder {
  readonly lens: FrozenLens
  readonly reason: string
}

export interface FinderSelection {
  readonly runnable: ReadonlyArray<FrozenLens>
  readonly skipped: ReadonlyArray<SkippedFinder>
}

// Two Lens identities carry an intrinsic execution rule: spec-conformance is
// meaningless without a ReviewSpecification, and standards is meaningless
// without the Governing standards block a Standards Manifest feeds it. Keep
// either frozen in the selected plan, but do not turn its inapplicability
// into an invocation or a coverage gap.
const skipReason = (
  lens: FrozenLens,
  plan: ReviewPlan,
): string | undefined => {
  if (
    lens.name === SPEC_CONFORMANCE_LENS_NAME &&
    plan.specification === undefined
  ) {
    return "no ReviewSpecification"
  }
  if (
    lens.name === STANDARDS_LENS_NAME &&
    !lens.promptText.includes(GOVERNING_STANDARDS_HEADING)
  ) {
    return "no Standards Manifest"
  }
  return undefined
}

export const selectRunnableFinders = (plan: ReviewPlan): FinderSelection => {
  const runnable: Array<FrozenLens> = []
  const skipped: Array<SkippedFinder> = []
  for (const lens of plan.lenses) {
    const reason = skipReason(lens, plan)
    if (reason === undefined) {
      runnable.push(lens)
    } else {
      skipped.push({ lens, reason })
    }
  }
  return { runnable, skipped }
}
