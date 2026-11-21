import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Hash from "effect/Hash"
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
  finderToolsFor,
  loadFinderPromptTemplates,
  loadRelatedFilesTemplate,
  RELATIVE_REPO_ROOT,
  renderRelatedFiles,
  workspacePromptForReadOnly,
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
import { writeArtifactJson } from "./artifact.ts"
import { FINDER_FOLLOWER_WAIT_MILLIS, REVIEW_INVOCATION_DEADLINE_MILLIS } from "./invocation-policy.ts"
import {
  finderInvocationsInPlan,
  finderPartitionsInPlan,
} from "./finder-partitions.ts"
import { gatherRelatedFiles } from "../workspace/related-files.ts"
import { cacheShare, counted, invocationTrail, runProgress } from "./progress-text.ts"
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

// One Finder partition: its Host agent, its provider cache key, and the
// shared context every one of its system prompts carries.
interface Partition {
  readonly role: string
  readonly label: string
  readonly cacheGroup: string
  readonly systemPrompt: string
  readonly sharedContext: string
}

// The provider cache key comes from the prefix itself, not the Run, so a
// later Run over the same change finds the cache an earlier one warmed.
const cacheGroupFor = (seat: string, sharedContext: string) =>
  `gauntlet-finders-${(Hash.string(`${seat}\n${sharedContext}`) >>> 0).toString(36)}`

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

const reportFinderDone = (result: FinderResult) =>
  runProgress(
    `finder ${result.lens.name} done — ${counted(result.outcome.output?.findings.length ?? 0, "candidate")} · ${invocationTrail(result.outcome)}`,
    cacheShare([result.outcome.usage]),
  )

// The completed fan-out is recorded in finder-stage.json, in plan order, so
// the run directory holds every Finder's full outcome. An invocation failure
// in any Finder fails the whole stage.
export const executeFinders = Effect.fn(
  "gauntlet.finder_execution.execute",
)(function* ({ plan, paths, reviewWorkingDirectory }: FinderExecutionInput) {
  const invocations = finderInvocationsInPlan(plan)

  // Gathered once, by the first partition that needs it.
  const relatedFilesSection = yield* Effect.cached(
    Effect.gen(function* () {
      if (plan.relatedFiles !== true) return undefined

      const relatedFiles = yield* gatherRelatedFiles(
        reviewWorkingDirectory,
        plan.target.changedFiles,
      ).pipe(
        Effect.mapError((cause) =>
          RunError.make({
            operation: "execute-plan",
            runId: plan.runId,
            reason: "could not gather the related-file context",
            cause,
          })
        ),
      )

      const template = yield* loadRelatedFilesTemplate()

      return yield* renderRelatedFiles(template, relatedFiles)
    }),
  )

  const makeFinderInput = (
    invocation: (typeof invocations)[number],
    partition: Partition,
  ) => ({
    invocationId: `${partition.label}-${invocation.invocationKey}`,
    role: partition.role,
    seat: invocation.seat,
    workspace: reviewWorkingDirectory,
    // The shared block rides in the system prompt, not the first user
    // message: OpenAI Codex shares a cached prefix across requests only for
    // `instructions`, and a user-message prefix is reused only within one
    // conversation (measured 2026-09-10: 0/3 vs 3/3 followers cached).
    systemPrompt: `${partition.systemPrompt}\n\n${partition.sharedContext}`,
    prompt: assembleFinderAssignment(invocation.lens),
    cacheGroup: partition.cacheGroup,
    contract: EmitFindings,
    tools: finderToolsFor(invocation.seat),
    deadlineMillis: REVIEW_INVOCATION_DEADLINE_MILLIS,
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
    const uncappedOutcome = yield* invoked
    const outcome = enforceCandidateCap(invocation.lens, uncappedOutcome)
    yield* reportFinderDone({ lens: invocation.lens, outcome })

    return { invocation, outcome }
  })

  const executeFinder = Effect.fn(
    "gauntlet.finder_execution.execute_finder",
  )(function* (
    invocation: (typeof invocations)[number],
    partition: Partition,
  ) {
    yield* runProgress(`invoking finder ${invocation.lens.name}`)

    return yield* finishFinder(invocation, invoke(makeFinderInput(invocation, partition)))
  })

  const groups = finderPartitionsInPlan(plan)

  const groupResults = yield* Effect.forEach(
    groups,
    (group, groupIndex) =>
      Effect.gen(function* () {
        const starter = Array.headNonEmpty(group)
        const promptTemplates = yield* loadFinderPromptTemplates(workspacePromptForReadOnly(starter.seat))

        // The Host's tools resolve relative paths in the snapshot, so the
        // prefix names no per-Run path.
        const baseContext = yield* assembleFinderContext(
          promptTemplates,
          plan.target,
          RELATIVE_REPO_ROOT,
          starter.context,
        )

        const relatedFiles = yield* relatedFilesSection

        const sharedContext = relatedFiles === undefined
          ? baseContext
          : `${baseContext}\n\n${relatedFiles}`

        const partition: Partition = {
          role: `finder-${String(groupIndex + 1)}`,
          label: `${plan.runId}-finders-${String(groupIndex + 1)}`,
          cacheGroup: cacheGroupFor(starter.seat, sharedContext),
          systemPrompt: promptTemplates.systemPrompt,
          sharedContext,
        }

        if (group.length === 1) {
          const [completed, failed] = yield* Effect.partition(
            group,
            (invocation) =>
              executeFinder(invocation, partition).pipe(
                Effect.mapError((error) => ({ invocation, error })),
              ),
          )

          return { failed, completed }
        }

        yield* runProgress(`invoking finder ${starter.lens.name}`)
        const starterInput = makeFinderInput(starter, partition)
        const running = yield* invokeSignaled(starterInput)

        const signal = yield* running.firstResponse.pipe(
          Effect.timeoutOption(Duration.millis(FINDER_FOLLOWER_WAIT_MILLIS)),
        )

        if (Option.isNone(signal)) {
          yield* runProgress(
            `finder ${starter.lens.name} streamed nothing within ${String(FINDER_FOLLOWER_WAIT_MILLIS / 1000)}s; starting the rest of its partition`,
          )
        } else if (PrefixSignal.$is("PrefixObserved")(signal.value)) {
          yield* (yield* FinderCacheSettle)
        }

        const [completed, failed] = yield* Effect.partition(
          group,
          (invocation) =>
            (invocation === starter
              ? finishFinder(starter, running.outcome)
              : executeFinder(invocation, partition)
            ).pipe(Effect.mapError((error) => ({ invocation, error }))),
          { concurrency: "unbounded" },
        )

        return { failed, completed }
      }),
    { concurrency: "unbounded" },
  )

  const failures = Array.flatMap(groupResults, ({ failed }) => failed)
  const firstFailure = Array.head(failures)

  if (Option.isSome(firstFailure)) return yield* firstFailure.value.error

  const completedByKey = HashMap.fromIterable(
    pipe(
      groupResults,
      Array.flatMap(({ completed }) => completed),
      Array.map((result) => [result.invocation.invocationKey, result] as const),
    ),
  )

  const ordered = Array.filterMap(invocations, (invocation) =>
    HashMap.get(completedByKey, invocation.invocationKey).pipe(
      Result.fromOption(() => undefined),
      Result.map((result) => ({ invocation, outcome: result.outcome })),
    ))

  const finders = Array.map(ordered, ({ invocation, outcome }): FinderResult => ({
    lens: invocation.lens,
    outcome,
  }))

  yield* writeArtifactJson(paths.finderStage, FinderStageArtifact, {
    runId: plan.runId,
    finders: Array.map(ordered, ({ invocation, outcome }) => ({
      invocationKey: invocation.invocationKey,
      outcome,
    })),
  })
  yield* Effect.log("Finder stage recorded", { path: paths.finderStage })

  return { finders }
})
