import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Record from "effect/Record"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
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
  resolveFinderContext,
} from "../content/finder-prompt.ts"
import {
  AgentOutcome,
  type AgentOutcome as AgentOutcomeType,
} from "../domain/agent-outcome.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { invoke, PreloadOutput, preloadConversation } from "../harness/invoke.ts"
import type { ReplayableConversationPrefix } from "../harness/harness-session.ts"
import {
  EmitFindings,
} from "../harness/output-contract.ts"
import { readOptionalArtifactText, writeArtifactJson } from "./artifact.ts"
import { finderInvocationsInPlan } from "./invocation-journal.ts"
import { REVIEW_INVOCATION_DEADLINES } from "./invocation-policy.ts"
import { counted, invocationTrail } from "./progress-text.ts"
import type { RunPaths } from "./run-record.ts"
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

export interface FinderExecutionInput {
  readonly plan: ReviewPlan
  readonly paths: RunPaths
  readonly reviewWorkingDirectory: string
}

const FinderStageEntry = Schema.Struct({
  invocationKey: Schema.NonEmptyString,
  outcome: AgentOutcome(EmitFindings.schema),
})

export const FinderStageArtifact = Schema.Struct({
  runId: Schema.NonEmptyString,
  finders: Schema.Array(FinderStageEntry),
  preloads: Schema.Array(AgentOutcome(PreloadOutput)),
})
export interface FinderStageArtifact extends Schema.Schema.Type<
  typeof FinderStageArtifact
> {}

interface FinderExecutionResult {
  readonly finders: ReadonlyArray<FinderResult>
  readonly preloads: ReadonlyArray<AgentOutcomeType<PreloadOutput>>
}

export const FinderStageCheckpoint = Context.Reference<
  (runId: string) => Effect.Effect<void>
>("gauntlet/FinderStageCheckpoint", {
  defaultValue: () => () => Effect.void,
})

const readCompletedFinderStage = Effect.fn(
  "gauntlet.finder_execution.read_completed_stage",
)(function* (plan: ReviewPlan, artifactPath: string) {
  const source = yield* readOptionalArtifactText(artifactPath)
  const decoded = Option.flatMap(source, (text) =>
    Schema.decodeOption(Schema.fromJsonString(FinderStageArtifact))(text)
  )
  if (Option.isNone(decoded) || decoded.value.runId !== plan.runId) {
    return Option.none<FinderExecutionResult>()
  }

  const invocations = finderInvocationsInPlan(plan)
  const storedByKey = HashMap.fromIterable(
    decoded.value.finders.map((entry) =>
      [entry.invocationKey, entry.outcome] as const
    ),
  )
  const finders = Array.filterMap(invocations, (invocation) =>
    HashMap.get(storedByKey, invocation.invocationKey).pipe(
      Result.fromOption(() => undefined),
      Result.map((outcome): FinderResult => ({
        lens: invocation.lens,
        outcome: enforceCandidateCap(invocation.lens, outcome),
      })),
    ))
  if (
    decoded.value.finders.length !== invocations.length ||
    finders.length !== invocations.length
  ) {
    return Option.none<FinderExecutionResult>()
  }
  return Option.some({ finders, preloads: decoded.value.preloads })
})

// A completed Finder fan-out is the first resumable semantic checkpoint.
// Partial Finder outcomes and preload attempts never participate in control
// flow: absent or invalid stage state reruns the whole fan-out from scratch.
export const executeFinders = Effect.fn(
  "gauntlet.finder_execution.execute",
)(function* ({ plan, paths, reviewWorkingDirectory }: FinderExecutionInput) {
  const completed = yield* readCompletedFinderStage(plan, paths.finderStage)
  if (Option.isSome(completed)) {
    yield* progress("reusing completed Finder stage")
    return completed.value
  }

  const invocations = finderInvocationsInPlan(plan)
  const templates = yield* Effect.cached(loadFinderPromptTemplates())

  const executeFinder = Effect.fn(
    "gauntlet.finder_execution.execute_finder",
  )(function* (
    invocation: (typeof invocations)[number],
    cacheGroupId: string,
    conversationPrefix: ReplayableConversationPrefix | undefined,
  ) {
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
    yield* progress(
      `finder ${invocation.lens.name} done — ${counted(outcome.output?.findings.length ?? 0, "candidate")} · ${invocationTrail(outcome.durationMillis, outcome.usage.costUsd, outcome.termination)}`,
    )
    return { invocation, outcome }
  })

  const groups = Record.values(
    Array.groupBy(
      invocations,
      (invocation) =>
        `${invocation.seat}\u0000${resolveFinderContext(invocation.lens, plan.specification).key}`,
    ),
  )
  const groupResults = yield* Effect.forEach(
    groups,
    (group, groupIndex) =>
      Effect.gen(function* () {
        const cacheGroupId = `${plan.runId}-finders-${String(groupIndex + 1)}`
        let conversationPrefix: ReplayableConversationPrefix | undefined
        let preloadOutcome: AgentOutcomeType<PreloadOutput> | undefined
        const [first, second] = group
        if (first !== undefined && second !== undefined) {
          const promptTemplates = yield* templates
          const context = yield* assembleFinderContext(
            promptTemplates.sharedPromptTemplate,
            plan.target,
            REVIEW_WORKSPACE_ROOT,
            resolveFinderContext(first.lens, plan.specification),
          )
          yield* progress(
            `invoking finder preload (${String(group.length)} followers)`,
          )
          const attempted = yield* preloadConversation({
            seat: first.seat,
            cwd: reviewWorkingDirectory,
            systemPrompt: promptTemplates.systemPrompt,
            prompt: `${context}\n\n${FINDER_PRELOAD_TURN}`,
            cacheGroupId,
            expectedAcknowledgment: FINDER_PRELOAD_ACKNOWLEDGMENT,
            followerContract: EmitFindings,
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
            preloadOutcome = attempted.value.outcome
            conversationPrefix = attempted.value.conversationPrefix
            if (conversationPrefix !== undefined) {
              yield* (yield* FinderCacheSettle)
            } else {
              yield* progress(
                `finder preload unavailable — ${attempted.value.outcome.termination._tag}`,
              )
            }
          }
        }

        const [failed, completed] = yield* Effect.partition(
          group,
          (invocation) =>
            executeFinder(
              invocation,
              cacheGroupId,
              conversationPrefix,
            ).pipe(Effect.mapError((error) => ({ invocation, error }))),
          { concurrency: "unbounded" },
        )
        return {
          failed,
          completed,
          preloads: preloadOutcome === undefined ? [] : [preloadOutcome],
        }
      }),
    { concurrency: "unbounded" },
  )

  const failures = groupResults.flatMap(({ failed }) => failed)
  const firstFailure = failures[0]
  if (firstFailure !== undefined) return yield* firstFailure.error

  const completedByKey = HashMap.fromIterable(
    groupResults
      .flatMap(({ completed }) => completed)
      .map((result) => [result.invocation.invocationKey, result] as const),
  )
  const finders = Array.filterMap(invocations, (invocation) =>
    HashMap.get(completedByKey, invocation.invocationKey).pipe(
      Result.fromOption(() => undefined),
      Result.map((result): FinderResult => ({
        lens: result.invocation.lens,
        outcome: result.outcome,
      })),
    ))
  const preloads = groupResults.flatMap((group) => group.preloads)
  yield* writeArtifactJson(paths.finderStage, FinderStageArtifact, {
    runId: plan.runId,
    finders: invocations.flatMap((invocation) => {
      const completed = HashMap.get(completedByKey, invocation.invocationKey)
      return Option.isSome(completed)
        ? [{ invocationKey: invocation.invocationKey, outcome: completed.value.outcome }]
        : []
    }),
    preloads,
  })
  yield* (yield* FinderStageCheckpoint)(plan.runId)
  yield* Effect.log("Finder stage checkpointed", { path: paths.finderStage })
  return { finders, preloads }
})
