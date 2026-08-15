import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import * as Result from "effect/Result"
import { assembleDossier } from "../assembly/dossier.ts"
import {
  enforceCandidateCap,
  type FinderResult,
  routeFinderResults,
} from "../assembly/finders.ts"
import {
  assembleFinderAssignment,
  assembleFinderContext,
  assembleFinderPrompt,
  FINDER_PRELOAD_TURN,
  FINDER_TOOLS,
  loadFinderPromptTemplates,
} from "../content/finder-prompt.ts"
import { Dossier } from "../domain/dossier.ts"
import type { AgentOutcome } from "../domain/agent-outcome.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import {
  invoke,
  PreloadOutput,
  preloadConversation,
} from "../harness/invoke.ts"
import type { ReplayableConversationPrefix } from "../harness/harness-session.ts"
import {
  EmitFindings,
  type FindingsOutput,
} from "../harness/output-contract.ts"
import { renderDigest } from "../render/digest.ts"
import { renderDossierMarkdown } from "../render/dossier-markdown.ts"
import { writeArtifactJson, writeArtifactText } from "./artifact.ts"
import { executeBugClaimPath } from "./bug-claim-path.ts"
import {
  executeJournaledInvocation,
  finderInvocationsInPlan,
  nextJournalInvocationKey,
  readJournaledInvocation,
  writeInvocationJournal,
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

// Cache delivery is provider best-effort. Scheduling depends only on the
// frozen Seat and exact shared-context shape; adapters may map cacheGroupId to
// a native cache/session key without leaking provider logic up here.
const CACHE_SETTLE_MILLIS = 1_500

export const FinderCacheSettle = Context.Reference<Effect.Effect<void>>(
  "gauntlet/FinderCacheSettle",
  {
    defaultValue: () => Effect.sleep(Duration.millis(CACHE_SETTLE_MILLIS)),
  },
)

const finderContextKind = (
  plan: ReviewPlan,
  invocation: ReturnType<typeof finderInvocationsInPlan>[number],
): "standard" | "interpretive-with-review-specification" =>
  invocation.lens.finderClass === "interpretive" &&
    plan.specification !== undefined
    ? "interpretive-with-review-specification"
    : "standard"

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
          cacheGroupId: string,
          stored: AgentOutcome<FindingsOutput> | undefined,
          conversationPrefix: ReplayableConversationPrefix | undefined,
        ) {
          const journaled = stored === undefined
            ? yield* executeJournaledInvocation({
                journalDirectory: paths.journalDirectory,
                runId: plan.runId,
                invocationKey: invocation.invocationKey,
                output: EmitFindings.schema,
                execute: Effect.gen(function* () {
                  const promptTemplates = yield* templates
                  // A warmed follower appends only its assignment to the
                  // captured shared conversation. A singleton or degraded
                  // preload receives the same complete prompt as before.
                  const prompt = conversationPrefix === undefined
                    ? yield* assembleFinderPrompt(
                        promptTemplates.sharedPromptTemplate,
                        plan.target,
                        REVIEW_WORKSPACE_ROOT,
                        invocation.lens,
                        plan.specification,
                      )
                    : assembleFinderAssignment(invocation.lens)
                  yield* progress(`invoking finder ${invocation.lens.name}`)
                  const invokeInput = {
                    seat: invocation.seat,
                    cwd: reviewWorkingDirectory,
                    systemPrompt: promptTemplates.systemPrompt,
                    prompt,
                    cacheGroupId,
                    contract: EmitFindings,
                    tools: FINDER_TOOLS,
                    deadlines: REVIEW_INVOCATION_DEADLINES,
                  }
                  const outcome = yield* invoke(
                    conversationPrefix === undefined
                      ? invokeInput
                      : { ...invokeInput, conversationPrefix },
                  )
                  return enforceCandidateCap(invocation.lens, outcome)
                }),
              })
            : { outcome: stored, reused: true as const }
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
          cacheGroupId: string,
          storedByKey: HashMap.HashMap<string, AgentOutcome<FindingsOutput>>,
          conversationPrefix: ReplayableConversationPrefix | undefined,
        ) =>
          Effect.partition(
            groupedInvocations,
            (invocation) =>
              executeFinder(
                invocation,
                cacheGroupId,
                Option.getOrUndefined(
                  HashMap.get(storedByKey, invocation.invocationKey),
                ),
                conversationPrefix,
              ).pipe(
                Effect.mapError((error) => ({ invocation, error })),
              ),
            { concurrency: "unbounded" },
          )

        const groups = Record.values(
          Array.groupBy(
            invocations,
            (invocation) =>
              `${invocation.seat}\u0000${finderContextKind(plan, invocation)}`,
          ),
        )
        const findersStartedAt = yield* DateTime.now
        const groupResults = yield* Effect.forEach(
          groups,
          (group, groupIndex) =>
            Effect.gen(function* () {
              const cacheGroupId =
                `${plan.runId}-finders-${String(groupIndex + 1)}`
              let preloadOutcome: AgentOutcome<PreloadOutput> | undefined
              const storedEntries = yield* Effect.forEach(
                group,
                (invocation) =>
                  readJournaledInvocation({
                    journalDirectory: paths.journalDirectory,
                    runId: plan.runId,
                    invocationKey: invocation.invocationKey,
                    output: EmitFindings.schema,
                  }).pipe(
                    Effect.map((stored) => ({ invocation, stored })),
                  ),
              )
              const storedByKey = HashMap.fromIterable(
                storedEntries.flatMap(({ invocation, stored }) =>
                  Option.isSome(stored)
                    ? [[invocation.invocationKey, stored.value] as const]
                    : []
                ),
              )
              const unfinished = storedEntries.flatMap(
                ({ invocation, stored }) =>
                  Option.isNone(stored) ? [invocation] : [],
              )
              let conversationPrefix: ReplayableConversationPrefix | undefined

              if (unfinished.length > 1) {
                const first = unfinished[0]
                if (first === undefined) {
                  return yield* new RunError({
                    operation: "execute-plan",
                    runId: plan.runId,
                    reason: "finder preload partition lost its first invocation",
                  })
                }
                const promptTemplates = yield* templates
                const context = yield* assembleFinderContext(
                  promptTemplates.sharedPromptTemplate,
                  plan.target,
                  REVIEW_WORKSPACE_ROOT,
                  first.lens,
                  plan.specification,
                )
                yield* progress(
                  `invoking finder preload (${String(unfinished.length)} followers)`,
                )
                const attempted = yield* preloadConversation({
                  seat: first.seat,
                  cwd: reviewWorkingDirectory,
                  systemPrompt: promptTemplates.systemPrompt,
                  prompt: `${context}\n\n${FINDER_PRELOAD_TURN}`,
                  cacheGroupId,
                  contract: EmitFindings,
                  tools: FINDER_TOOLS,
                  deadlines: REVIEW_INVOCATION_DEADLINES,
                }).pipe(
                  Effect.match({
                    onFailure: (error) => ({ error } as const),
                    onSuccess: (result) => ({ result } as const),
                  }),
                )
                if ("error" in attempted) {
                  yield* Effect.logWarning("finder preload unavailable", {
                    cacheGroupId,
                    reason: attempted.error.reason,
                  })
                  yield* progress(
                    `finder preload unavailable — ${attempted.error.reason}`,
                  )
                } else {
                  preloadOutcome = attempted.result.outcome
                  const preloadInvocationKey =
                    yield* nextJournalInvocationKey(
                      paths.journalDirectory,
                      `finder-preload-${String(groupIndex + 1)}`,
                    )
                  yield* writeInvocationJournal(
                    {
                      journalDirectory: paths.journalDirectory,
                      runId: plan.runId,
                      invocationKey: preloadInvocationKey,
                      output: PreloadOutput,
                    },
                    attempted.result.outcome,
                  )
                  conversationPrefix = attempted.result.conversationPrefix
                  if (conversationPrefix !== undefined) {
                    yield* (yield* FinderCacheSettle)
                  }
                }
              }

              const [failed, completed] = yield* executePartition(
                group,
                cacheGroupId,
                storedByKey,
                conversationPrefix,
              )
              return {
                failed,
                completed,
                preloadOutcome,
              }
            }),
          { concurrency: "unbounded" },
        )

        const preloadOutcomes = groupResults.flatMap((result) =>
          result.preloadOutcome === undefined ? [] : [result.preloadOutcome]
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
            preloadOutcomes.reduce(
              (total, outcome) => total + outcome.usage.costUsd,
              0,
            ),
          ) + bugClaimPath.costUsd + judgmentPath.costUsd,
          invocationCount:
            invocations.length +
            preloadOutcomes.length +
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
