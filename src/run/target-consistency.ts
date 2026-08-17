import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { resolvePullRequestTarget } from "../target/pull-request.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"

const reviewTargetEquivalence = Schema.toEquivalence(ReviewTarget)

// The sole target comparison: resume must not reuse a completed Finder stage
// against a change the developer has since altered. In-flight invocations
// need no
// per-call check — they read the Run's frozen snapshot worktree, not the
// live checkout (#56).
export const liveTargetMatchesPlan = Effect.fn(
  "gauntlet.run_executor.live_target_matches_plan",
)(function* (plan: ReviewPlan) {
  const current = yield* (
    ReviewTarget.guards.WorkingTree(plan.target)
      ? resolveWorkingTreeTarget(plan.target.repoRoot)
      : resolvePullRequestTarget(plan.target.repoRoot, plan.target.number)
  )
  return reviewTargetEquivalence(plan.target, current)
})
