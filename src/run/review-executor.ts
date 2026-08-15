import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Logger from "effect/Logger"
import * as Record from "effect/Record"
import * as Result from "effect/Result"
import { assembleDossier } from "../assembly/dossier.ts"
import {
  enforceCandidateCap,
  type FinderResult,
  routeFinderResults,
} from "../assembly/finders.ts"
import {
  assembleFinderPrompt,
  FINDER_TOOLS,
  loadFinderPromptTemplates,
} from "../content/finder-prompt.ts"
import { Dossier } from "../domain/dossier.ts"
import { modelIdentityOfSeat } from "../domain/recipe.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { invoke } from "../harness/invoke.ts"
import { EmitFindings } from "../harness/output-contract.ts"
import { renderDigest } from "../render/digest.ts"
import { renderDossierMarkdown } from "../render/dossier-markdown.ts"
import { writeArtifactJson, writeArtifactText } from "./artifact.ts"
import { executeBugClaimPath } from "./bug-claim-path.ts"
import {
  executeJournaledInvocation,
  finderInvocationsInPlan,
} from "./invocation-journal.ts"
import {
  counted,
  coverageGapLine,
  invocationTrail,
  wallSeconds,
} from "./progress-text.ts"
import { executeJudgment } from "../stages/judgment/judgment.ts"
import { RunError, type RunPaths } from "./run-record.ts"
import { REVIEW_INVOCATION_DEADLINES } from "./invocation-policy.ts"
import { acquireReviewWorkingDirectory } from "./review-working-directory.ts"
import { REVIEW_WORKSPACE_ROOT } from "../workspace/review-workspace.ts"

// Pi uses the shared session id as its provider cache partition. Each model
// group completes one real finder before its siblings fan out, then gives the
// provider's prefix cache a short settle window (research/pi-harness-surface).
const CACHE_SETTLE_MILLIS = 1_500

const progress = Effect.fn("gauntlet.run_executor.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

export interface ReviewExecution {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly startedAt: DateTime.Utc
}

export const executeReviewPlan = Effect.fn(
  "gauntlet.run_executor.execute_review_plan",
)(function* ({ paths, plan, startedAt }: ReviewExecution) {
  const invocations = finderInvocationsInPlan(plan)
  yield* progress(`run ${plan.runId}`)
  yield* Effect.scoped(
    Effect.gen(function* () {
      const fileLogger = yield* Logger.toFile(Logger.formatLogFmt, paths.runLog)
      const reviewWorkingDirectory = yield* acquireReviewWorkingDirectory(
        plan.target,
        plan.runId,
      )
      yield* Effect.gen(function* () {
        yield* Effect.log(`run ${plan.runId} executing`)
        const templates = yield* Effect.cached(loadFinderPromptTemplates())

        const executeFinder = Effect.fn(
          "gauntlet.run_executor.execute_finder",
        )(function* (
          invocation: (typeof invocations)[number],
          sessionId: string,
        ) {
          const journaled = yield* executeJournaledInvocation({
            journalDirectory: paths.journalDirectory,
            runId: plan.runId,
            invocationKey: invocation.invocationKey,
            output: EmitFindings.schema,
            execute: Effect.gen(function* () {
              const promptTemplates = yield* templates
              // The prompt shows the stable virtual root the tools expose;
              // cwd carries the host snapshot path the overlay mounts on.
              const prompt = yield* assembleFinderPrompt(
                promptTemplates.sharedPromptTemplate,
                plan.target,
                REVIEW_WORKSPACE_ROOT,
                invocation.lens,
                plan.specification,
              )
              yield* progress(`invoking finder ${invocation.lens.name}`)
              const outcome = yield* invoke({
                seat: invocation.seat,
                cwd: reviewWorkingDirectory,
                systemPrompt: promptTemplates.systemPrompt,
                prompt,
                sessionId,
                contract: EmitFindings,
                tools: FINDER_TOOLS,
                deadlines: REVIEW_INVOCATION_DEADLINES,
              })
              return enforceCandidateCap(invocation.lens, outcome)
            }),
          })
          const outcome = journaled.reused
            ? enforceCandidateCap(invocation.lens, journaled.outcome)
            : journaled.outcome
          if (journaled.reused) {
            yield* progress(
              `reusing finder ${invocation.lens.name} from journal`,
            )
            yield* Effect.log("finder invocation reused", {
              invocationKey: invocation.invocationKey,
            })
          } else {
            yield* Effect.log("finder invocation journaled", {
              invocationKey: invocation.invocationKey,
            })
          }
          yield* progress(
            `finder ${invocation.lens.name} done — ${counted(outcome.output?.findings.length ?? 0, "candidate")} · ${invocationTrail(outcome.durationMillis, outcome.usage.costUsd, outcome.termination)}`,
          )
          return {
            invocation,
            outcome,
            reused: journaled.reused,
          }
        })

        const executePartition = (
          groupedInvocations: ReadonlyArray<(typeof invocations)[number]>,
          sessionId: string,
        ) =>
          Effect.partition(
            groupedInvocations,
            (invocation) =>
              executeFinder(invocation, sessionId).pipe(
                Effect.mapError((error) => ({ invocation, error })),
              ),
            { concurrency: "unbounded" },
          )

        const groups = Record.values(
          Array.groupBy(invocations, (invocation) =>
            modelIdentityOfSeat(invocation.seat)),
        )
        const findersStartedAt = yield* DateTime.now
        const groupResults = yield* Effect.forEach(
          groups,
          (group, groupIndex) =>
            Effect.gen(function* () {
              const sessionId =
                `${plan.runId}-finders-${String(groupIndex + 1)}`
              const failed = []
              const completed = []
              let cursor = 0
              let warmed = false

              // On resume, leading journal hits are free and do not warm the
              // provider cache in this process. The first missing invocation
              // is therefore the warmup; a setup failure does not prevent the
              // next sibling from trying to establish the prefix.
              for (const invocation of group) {
                if (warmed) break
                const [invocationFailures, invocationResults] =
                  yield* executePartition([invocation], sessionId)
                failed.push(...invocationFailures)
                completed.push(...invocationResults)
                cursor += 1
                warmed = invocationResults.some((result) => !result.reused)
              }

              const followers = Array.drop(group, cursor)
              if (warmed && followers.length > 0) {
                yield* Effect.sleep(Duration.millis(CACHE_SETTLE_MILLIS))
              }
              const [followerFailures, followerResults] =
                yield* executePartition(followers, sessionId)
              return {
                failed: [...failed, ...followerFailures],
                completed: [...completed, ...followerResults],
              }
            }),
          { concurrency: "unbounded" },
        )

        const failures = groupResults.flatMap((result) => result.failed)
        const firstFailure = failures[0]
        if (firstFailure !== undefined) {
          return yield* firstFailure.error
        }

        const completedByKey = HashMap.fromIterable(
          groupResults
            .flatMap((result) => result.completed)
            .map((result) => [result.invocation.invocationKey, result] as const),
        )
        const results = Array.filterMap(invocations, (invocation) =>
          HashMap.get(completedByKey, invocation.invocationKey).pipe(
            Result.fromOption(() => undefined),
            Result.map((result): FinderResult => ({
              lens: result.invocation.lens,
              outcome: result.outcome,
            })),
          ))
        if (results.length !== invocations.length) {
          return yield* new RunError({
            operation: "execute-plan",
            runId: plan.runId,
            reason: "finder partition completed without accounting for every invocation",
          })
        }

        yield* progress(
          `Finders finished — ${String(yield* wallSeconds(findersStartedAt))}s`,
        )
        const routed = routeFinderResults(results)
        for (const gap of routed.coverageGaps) {
          yield* progress(coverageGapLine(gap))
        }
        yield* progress(
          `${counted(routed.bugClaims.length, "BugClaim")} → Verification · ${counted(routed.observations.length, "Observation")} → Judgment`,
        )
        // The two evaluation paths share no state until Assembly joins them.
        const [bugClaimPath, judgmentPath] = yield* Effect.all(
          [
            executeBugClaimPath({
              plan,
              paths,
              reviewWorkingDirectory,
              bugClaims: routed.bugClaims,
            }),
            executeJudgment({
              plan,
              paths,
              reviewWorkingDirectory,
              observations: routed.observations,
            }),
          ],
          { concurrency: 2 },
        )
        const dossier = assembleDossier({
          plan,
          finderCoverageGaps: routed.coverageGaps,
          bugClaimPath,
          judgmentPath,
        })
        yield* progress("assembling dossier")
        yield* writeArtifactJson(paths.dossier, Dossier, dossier)

        const endedAt = yield* DateTime.now
        const wallTime = DateTime.distance(startedAt, endedAt)
        const accounting = {
          costUsd: results.reduce(
            (total, result) => total + result.outcome.usage.costUsd,
            0,
          ) + bugClaimPath.costUsd + judgmentPath.costUsd,
          invocationCount:
            invocations.length +
            bugClaimPath.invocationCount +
            judgmentPath.invocationCount,
          wallTimeSeconds: Math.round(Duration.toSeconds(wallTime)),
        }
        const dossierMarkdown = renderDossierMarkdown(plan, dossier, accounting)
        yield* writeArtifactText(paths.dossierMarkdown, dossierMarkdown)
        yield* Effect.log("dossier rendered", { path: paths.dossierMarkdown })

        yield* Console.log(renderDigest(plan, dossier, accounting, paths))
      }).pipe(Effect.provide(Logger.layer([fileLogger])))
    }),
  )
})
