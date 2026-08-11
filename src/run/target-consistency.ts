import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
import { RunError } from "./run-record.ts"

const reviewTargetEquivalence = Schema.toEquivalence(ReviewTarget)

// A journal hit is already bound to the frozen plan. Only an invocation that
// will read the repository again needs the working-tree consistency check.
export const ensureWorkingTreeUnchanged = Effect.fn(
  "gauntlet.run_executor.ensure_working_tree_unchanged",
)(function* (plan: ReviewPlan) {
  if (plan.target._tag !== "WorkingTree") return
  const current = yield* resolveWorkingTreeTarget(plan.target.repoRoot)
  if (reviewTargetEquivalence(plan.target, current)) return
  return yield* new RunError({
    operation: "execute-plan",
    runId: plan.runId,
    reason:
      `working tree changed after run ${plan.runId} froze its review target; ` +
      "start a new review instead of paying an invocation against mixed scope",
  })
})
