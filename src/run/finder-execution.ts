import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import * as Result from "effect/Result"
import {
  enforceCandidateCap,
  type FinderResult,
} from "../assembly/finders.ts"
import {
  assembleFinderAssignment,
  assembleFinderContext,
  assembleFinderPrompt,
  FINDER_PRELOAD_ACKNOWLEDGMENT,
  FINDER_PRELOAD_TURN,
  FINDER_TOOLS,
  loadFinderPromptTemplates,
} from "../content/finder-prompt.ts"
import type { AgentOutcome } from "../domain/agent-outcome.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { invoke, PreloadOutput, preloadConversation } from "../harness/invoke.ts"
import type { ReplayableConversationPrefix } from "../harness/harness-session.ts"
import {
  EmitFindings,
  type FindingsOutput,
} from "../harness/output-contract.ts"
import {
  finderInvocationsInPlan,
  nextJournalInvocationKey,
  readJournaledInvocation,
  writeInvocationJournal,
} from "./invocation-journal.ts"
import { REVIEW_INVOCATION_DEADLINES } from "./invocation-policy.ts"
import { counted, invocationTrail } from "./progress-text.ts"
import { RunError, type RunPaths } from "./run-record.ts"
import { REVIEW_WORKSPACE_ROOT } from "../workspace/review-workspace.ts"

const CACHE_SETTLE_MILLIS = 1_500

export const FinderCacheSettle = Context.Reference<Effect.Effect<void>>(
  "gauntlet/FinderCacheSettle",
  {
    defaultValue: () => Effect.sleep(Duration.millis(CACHE_SETTLE_MILLIS)),
  },
)

const progress = Effect.fn("gauntlet.finder_execution.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

const finderContextKind = (
  plan: ReviewPlan,
  invocation: ReturnType<typeof finderInvocationsInPlan>[number],
): "standard" | "interpretive-with-review-specification" =>
  invocation.lens.finderClass === "interpretive" &&
    plan.specification !== undefined
    ? "interpretive-with-review-specification"
    : "standard"

export interface FinderExecutionInput {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly reviewWorkingDirectory: string
}

// This module owns the complete Finder partition lifecycle: one resume read,
// optional paid preload, one journal write per fresh outcome, and stable-order
// reconstruction. The top-level executor only routes the completed results.
export const executeFinders = Effect.fn(
  "gauntlet.finder_execution.execute",
)(function* ({ plan, paths, reviewWorkingDirectory }: FinderExecutionInput) {
  const invocations = finderInvocationsInPlan(plan)
  const templates = yield* Effect.cached(loadFinderPromptTemplates())

  const executeFinder = Effect.fn(
    "gauntlet.finder_execution.execute_finder",
  )(function* (
    invocation: (typeof invocations)[number],
    cacheGroupId: string,
    stored: AgentOutcome<FindingsOutput> | undefined,
    conversationPrefix: ReplayableConversationPrefix | undefined,
  ) {
    if (stored !== undefined) {
      const outcome = enforceCandidateCap(invocation.lens, stored)
      yield* progress(`reusing finder ${invocation.lens.name} from journal`)
      yield* Effect.log("finder invocation reused", {
        invocationKey: invocation.invocationKey,
      })
      yield* progress(
        `finder ${invocation.lens.name} done — ${counted(outcome.output?.findings.length ?? 0, "candidate")} · ${invocationTrail(outcome.durationMillis, outcome.usage.costUsd, outcome.termination)}`,
      )
      return { invocation, outcome }
    }

    const promptTemplates = yield* templates
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
    const invoked = yield* invoke(
      conversationPrefix === undefined
        ? invokeInput
        : { ...invokeInput, conversationPrefix },
    )
    const outcome = enforceCandidateCap(invocation.lens, invoked)
    yield* writeInvocationJournal(
      {
        journalDirectory: paths.journalDirectory,
        runId: plan.runId,
        invocationKey: invocation.invocationKey,
        output: EmitFindings.schema,
      },
      outcome,
    )
    yield* Effect.log("finder invocation journaled", {
      invocationKey: invocation.invocationKey,
    })
    yield* progress(
      `finder ${invocation.lens.name} done — ${counted(outcome.output?.findings.length ?? 0, "candidate")} · ${invocationTrail(outcome.durationMillis, outcome.usage.costUsd, outcome.termination)}`,
    )
    return { invocation, outcome }
  })

  const groups = Record.values(
    Array.groupBy(
      invocations,
      (invocation) =>
        `${invocation.seat}\u0000${finderContextKind(plan, invocation)}`,
    ),
  )
  const groupResults = yield* Effect.forEach(
    groups,
    (group, groupIndex) =>
      Effect.gen(function* () {
        const cacheGroupId = `${plan.runId}-finders-${String(groupIndex + 1)}`
        const storedEntries = yield* Effect.forEach(group, (invocation) =>
          readJournaledInvocation({
            journalDirectory: paths.journalDirectory,
            runId: plan.runId,
            invocationKey: invocation.invocationKey,
            output: EmitFindings.schema,
          }).pipe(Effect.map((stored) => ({ invocation, stored }))))
        const storedByKey = HashMap.fromIterable(
          storedEntries.flatMap(({ invocation, stored }) =>
            Option.isSome(stored)
              ? [[invocation.invocationKey, stored.value] as const]
              : []
          ),
        )
        const unfinished = storedEntries.flatMap(({ invocation, stored }) =>
          Option.isNone(stored) ? [invocation] : []
        )
        let conversationPrefix: ReplayableConversationPrefix | undefined
        const [first, second] = unfinished
        if (first !== undefined && second !== undefined) {
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
            expectedAcknowledgment: FINDER_PRELOAD_ACKNOWLEDGMENT,
            contract: EmitFindings,
            tools: FINDER_TOOLS,
            deadlines: REVIEW_INVOCATION_DEADLINES,
          }).pipe(
            Effect.map(Option.some),
            Effect.catchTag("InvocationSetupError", (error) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("finder preload unavailable", {
                  cacheGroupId,
                  reason: error.reason,
                })
                yield* progress(`finder preload unavailable — ${error.reason}`)
                return Option.none()
              })),
          )
          if (Option.isSome(attempted)) {
            const preloadInvocationKey = yield* nextJournalInvocationKey(
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
              attempted.value.outcome,
            )
            conversationPrefix = attempted.value.conversationPrefix
            if (conversationPrefix !== undefined) {
              yield* (yield* FinderCacheSettle)
            }
          }
        }

        return yield* Effect.partition(
          group,
          (invocation) =>
            executeFinder(
              invocation,
              cacheGroupId,
              Option.getOrUndefined(
                HashMap.get(storedByKey, invocation.invocationKey),
              ),
              conversationPrefix,
            ).pipe(Effect.mapError((error) => ({ invocation, error }))),
          { concurrency: "unbounded" },
        )
      }),
    { concurrency: "unbounded" },
  )

  const failures = groupResults.flatMap(([failed]) => failed)
  const firstFailure = failures[0]
  if (firstFailure !== undefined) return yield* firstFailure.error

  const completedByKey = HashMap.fromIterable(
    groupResults
      .flatMap(([, completed]) => completed)
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
  return results
})
