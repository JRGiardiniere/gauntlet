import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { assembleSingleLensDossier } from "../assembly/single-lens.ts"
import {
  assembleFinderPrompt,
  FINDER_TOOLS,
  loadFinderPromptTemplates,
} from "../content/finder-prompt.ts"
import { Dossier } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import {
  ReviewTarget,
  targetIdentityOf,
} from "../domain/review-target.ts"
import { invoke } from "../harness/invoke.ts"
import { EmitFindings } from "../harness/output-contract.ts"
import { renderDigest } from "../render/digest.ts"
import { renderReport } from "../render/report.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
import { writeArtifactJson, writeArtifactText } from "./artifact.ts"
import {
  finderInvocationsInPlan,
  readFinderInvocation,
  writeFinderInvocation,
} from "./invocation-journal.ts"
import { RunError, type RunPaths } from "./run-record.ts"

// Test hook after the journal commit and before assembly.
export const InvocationJournalCheckpoint = Context.Reference<
  (runId: string, invocationKey: string) => Effect.Effect<void>
>("gauntlet/InvocationJournalCheckpoint", {
  defaultValue: () => () => Effect.void,
})

const TRACER_DEADLINES = {
  overallMillis: 600_000,
  startupMillis: 60_000,
  firstResponseMillis: 300_000,
  toolMillis: 120_000,
  bashMillis: 600_000,
} as const

const progress = Effect.fn("gauntlet.run_executor.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

const reviewTargetEquivalence = Schema.toEquivalence(ReviewTarget)

// Only missing invocations require the working tree frozen into the plan.
const ensureWorkingTreeUnchanged = Effect.fn(
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

export interface ReviewExecution {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly startedAt: DateTime.Utc
}

export const executeReviewPlan = Effect.fn(
  "gauntlet.run_executor.execute_review_plan",
)(function* ({ paths, plan, startedAt }: ReviewExecution) {
  const invocations = finderInvocationsInPlan(plan)
  const invocation = invocations[0]
  if (invocation === undefined || invocations.length !== 1) {
    return yield* new RunError({
      operation: "execute-plan",
      runId: plan.runId,
      reason:
        `run ${plan.runId} has ${invocations.length} finder invocations; ` +
        "this slice executes the single-lens tracer only",
    })
  }

  yield* progress(`run ${plan.runId}`)
  yield* Effect.scoped(
    Effect.gen(function* () {
      const fileLogger = yield* Logger.toFile(Logger.formatLogFmt, paths.runLog)
      yield* Effect.gen(function* () {
        yield* Effect.log(`run ${plan.runId} executing`)

        const cached = yield* readFinderInvocation(
          paths.journalDirectory,
          plan.runId,
          invocation.invocationKey,
        )
        const outcome = yield* Option.match(cached, {
          onNone: () =>
            Effect.gen(function* () {
              yield* ensureWorkingTreeUnchanged(plan)
              const templates = yield* loadFinderPromptTemplates()
              const prompt = yield* assembleFinderPrompt(
                templates.sharedPromptTemplate,
                plan.target,
                invocation.lens,
              )
              yield* progress(`invoking finder ${invocation.lens.name}`)
              const fresh = yield* invoke({
                cwd: plan.target.repoRoot,
                systemPrompt: templates.systemPrompt,
                prompt,
                sessionId: `${plan.runId}-finders`,
                contract: EmitFindings,
                tools: FINDER_TOOLS,
                deadlines: TRACER_DEADLINES,
              })
              yield* writeFinderInvocation(paths.journalDirectory, {
                runId: plan.runId,
                invocationKey: invocation.invocationKey,
                lens: invocation.lens.name,
                outcome: fresh,
              })
              yield* Effect.log("finder invocation journaled", {
                invocationKey: invocation.invocationKey,
              })
              const checkpoint = yield* InvocationJournalCheckpoint
              yield* checkpoint(plan.runId, invocation.invocationKey)
              return fresh
            }),
          onSome: (artifact) =>
            progress(
              `reusing finder ${invocation.lens.name} from journal`,
            ).pipe(
              Effect.andThen(
                Effect.log("finder invocation reused", {
                  invocationKey: invocation.invocationKey,
                }),
              ),
              Effect.as(artifact.outcome),
            ),
        })

        const dossier = assembleSingleLensDossier(
          plan.runId,
          targetIdentityOf(plan.target),
          invocation.lens,
          outcome.output,
        )
        yield* progress("assembling dossier")
        yield* writeArtifactJson(paths.dossier, Dossier, dossier)

        const endedAt = yield* DateTime.now
        const wallTime = DateTime.distance(startedAt, endedAt)
        const accounting = {
          costUsd: outcome.usage.costUsd,
          invocationCount: invocations.length,
          wallTimeSeconds: Math.round(Duration.toSeconds(wallTime)),
        }
        const report = renderReport(plan, dossier, accounting)
        yield* writeArtifactText(paths.report, report)
        yield* Effect.log("report rendered", { path: paths.report })

        yield* Console.log(renderDigest(plan, dossier, accounting, paths))
      }).pipe(Effect.provide(Logger.layer([fileLogger])))
    }),
  )
})
