import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as HashMap from "effect/HashMap"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  enforceCandidateCap,
  type FinderResult,
} from "../assembly/finders.ts"
import {
  assembleFinderAssignment,
  assembleFinderContext,
  FINDER_TOOLS,
  loadFinderPromptTemplates,
} from "../content/finder-prompt.ts"
import {
  AgentOutcome,
  type AgentOutcome as AgentOutcomeType,
} from "../domain/agent-outcome.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import type {
  HarnessSessionFactory,
  InvocationFailure,
} from "../harness/harness-session.ts"
import {
  invoke,
  invokeSignaled,
  PrefixSignal,
} from "../harness/invoke.ts"
import {
  EmitFindings,
  type FindingsOutput,
} from "../harness/output-contract.ts"
import { REVIEW_WORKSPACE_ROOT } from "../workspace/review-workspace.ts"
import { readOptionalArtifactText, writeArtifactJson } from "./artifact.ts"
import { REVIEW_INVOCATION_DEADLINES } from "./invocation-policy.ts"
import {
  finderInvocationsInPlan,
  finderPartitionsInPlan,
} from "./finder-partitions.ts"
import { counted, invocationTrail } from "./progress-text.ts"
import { RunError, type RunPaths } from "./run-record.ts"

const CACHE_SETTLE_MILLIS = 1_500
export const FinderCacheSettleDelay = Effect.sleep(
  Duration.millis(CACHE_SETTLE_MILLIS),
)

// A narrow test seam lets broad CLI tests skip time. The production delay is
// centralized above and its timing behavior is covered explicitly with TestClock.
export const FinderCacheSettle = Context.Reference<Effect.Effect<void>>(
  "gauntlet/FinderCacheSettle",
  {
    defaultValue: () => FinderCacheSettleDelay,
  },
)

const progress = Effect.fn("gauntlet.finder_execution.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

interface FinderExecutionInput {
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
})
export interface FinderStageArtifact extends Schema.Schema.Type<
  typeof FinderStageArtifact
> {}

interface FinderExecutionResult {
  readonly finders: ReadonlyArray<FinderResult>
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
  return Option.some({ finders })
})

const reportFinderDone = (result: FinderResult) =>
  progress(
    `finder ${result.lens.name} done — ${counted(result.outcome.output?.findings.length ?? 0, "candidate")} · ${invocationTrail(result.outcome.durationMillis, result.outcome.usage.costUsd, result.outcome.termination)}`,
  )

// A completed Finder fan-out is the first resumable semantic checkpoint.
// Partial outcomes never participate in control flow: absent or invalid stage
// state reruns the whole fan-out from scratch.
export const executeFinders = Effect.fn(
  "gauntlet.finder_execution.execute",
)(function* ({ plan, paths, reviewWorkingDirectory }: FinderExecutionInput) {
  const completed = yield* readCompletedFinderStage(plan, paths.finderStage)
  if (Option.isSome(completed)) {
    yield* progress("reusing completed Finder stage")
    yield* Effect.forEach(completed.value.finders, reportFinderDone, {
      discard: true,
    })
    return completed.value
  }

  const invocations = finderInvocationsInPlan(plan)
  const templates = yield* Effect.cached(loadFinderPromptTemplates())

  const makeFinderInput = Effect.fn(
    "gauntlet.finder_execution.make_finder_input",
  )(function* (
    invocation: (typeof invocations)[number],
    cacheGroupId: string,
    sharedContext: string,
  ) {
    const promptTemplates = yield* templates
    return {
      invocationId: `${cacheGroupId}-${invocation.invocationKey}`,
      seat: invocation.seat,
      cwd: reviewWorkingDirectory,
      // The shared block rides in the system prompt, not the first user
      // message: OpenAI Codex shares a cached prefix across requests only for
      // `instructions`, and a user-message prefix is reused only within one
      // conversation (measured 2026-09-10: 0/3 vs 3/3 followers cached).
      systemPrompt: `${promptTemplates.systemPrompt}\n\n${sharedContext}`,
      prompt: assembleFinderAssignment(invocation.lens),
      cacheGroupId,
      contract: EmitFindings,
      tools: FINDER_TOOLS,
      deadlines: REVIEW_INVOCATION_DEADLINES,
    }
  })

  const finishFinder = Effect.fn(
    "gauntlet.finder_execution.finish_finder",
  )(function* (
    invocation: (typeof invocations)[number],
    invoked: Effect.Effect<
      AgentOutcomeType<FindingsOutput>,
      InvocationFailure,
      HarnessSessionFactory
    >,
  ) {
    const outcome = enforceCandidateCap(invocation.lens, yield* invoked)
    yield* reportFinderDone({ lens: invocation.lens, outcome })
    return { invocation, outcome }
  })

  const executeFinder = Effect.fn(
    "gauntlet.finder_execution.execute_finder",
  )(function* (
    invocation: (typeof invocations)[number],
    cacheGroupId: string,
    sharedContext: string,
  ) {
    yield* progress(`invoking finder ${invocation.lens.name}`)
    const input = yield* makeFinderInput(
      invocation,
      cacheGroupId,
      sharedContext,
    )
    return yield* finishFinder(invocation, invoke(input))
  })

  const groups = finderPartitionsInPlan(plan)
  const groupResults = yield* Effect.forEach(
    groups,
    (group, groupIndex) =>
      Effect.gen(function* () {
        const cacheGroupId = `${plan.runId}-finders-${String(groupIndex + 1)}`
        const starter = Array.headNonEmpty(group)
        const promptTemplates = yield* templates
        const sharedContext = yield* assembleFinderContext(
          promptTemplates.sharedPromptTemplate,
          plan.target,
          REVIEW_WORKSPACE_ROOT,
          starter.context,
        )
        if (group.length === 1) {
          const [failed, completed] = yield* Effect.partition(
            group,
            (invocation) =>
              executeFinder(invocation, cacheGroupId, sharedContext).pipe(
                Effect.mapError((error) => ({ invocation, error })),
              ),
          )
          return { failed, completed }
        }

        yield* progress(`invoking finder ${starter.lens.name}`)
        const starterInput = yield* makeFinderInput(
          starter,
          cacheGroupId,
          sharedContext,
        )
        const running = yield* invokeSignaled(starterInput)
        const signal = yield* running.firstResponse
        if (PrefixSignal.$is("PrefixObserved")(signal)) {
          yield* (yield* FinderCacheSettle)
        }

        const [failed, completed] = yield* Effect.partition(
          group,
          (invocation) =>
            (invocation === starter
              ? finishFinder(starter, running.outcome)
              : executeFinder(invocation, cacheGroupId, sharedContext)
            ).pipe(Effect.mapError((error) => ({ invocation, error }))),
          { concurrency: "unbounded" },
        )
        return { failed, completed }
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
  const ordered = Array.filterMap(invocations, (invocation) =>
    HashMap.get(completedByKey, invocation.invocationKey).pipe(
      Result.fromOption(() => undefined),
      Result.map((result) => ({ invocation, outcome: result.outcome })),
    ))
  if (ordered.length !== invocations.length) {
    return yield* new RunError({
      operation: "execute-plan",
      runId: plan.runId,
      reason: "Finder stage completed without every planned invocation",
    })
  }
  const finders = ordered.map(({ invocation, outcome }): FinderResult => ({
    lens: invocation.lens,
    outcome,
  }))
  yield* writeArtifactJson(paths.finderStage, FinderStageArtifact, {
    runId: plan.runId,
    finders: ordered.map(({ invocation, outcome }) => ({
      invocationKey: invocation.invocationKey,
      outcome,
    })),
  })
  yield* (yield* FinderStageCheckpoint)(plan.runId)
  yield* Effect.log("Finder stage checkpointed", { path: paths.finderStage })
  return { finders }
})
