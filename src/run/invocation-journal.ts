import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { AgentOutcome } from "../domain/agent-outcome.ts"
import type { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { readOptionalArtifactText, writeArtifactJson } from "./artifact.ts"

// One journal entry per AgentInvocation: the stable key from the frozen plan
// and the full typed AgentOutcome (ADR 0003). Stage policy lives in the plan,
// never in this artifact.
export const InvocationArtifact = <S extends Schema.Top>(output: S) =>
  Schema.Struct({
    runId: Schema.NonEmptyString,
    invocationKey: Schema.NonEmptyString,
    outcome: AgentOutcome(output),
  })

export interface FrozenFinderInvocation {
  readonly invocationKey: string
  readonly lens: FrozenLens
}

export class InvocationJournalReadError extends Data.TaggedError(
  "InvocationJournalReadError",
)<{
  readonly path: string
  readonly cause: unknown
}> {}

// Test hook after the journal commit and before the caller resumes.
export const InvocationJournalCheckpoint = Context.Reference<
  (runId: string, invocationKey: string) => Effect.Effect<void>
>("gauntlet/InvocationJournalCheckpoint", {
  defaultValue: () => () => Effect.void,
})

export const finderInvocationsInPlan = (
  plan: ReviewPlan,
): ReadonlyArray<FrozenFinderInvocation> =>
  plan.lenses.map((lens) => ({
    invocationKey: `finder-${lens.name}`,
    lens,
  }))

const invocationPath = Effect.fn(
  "gauntlet.invocation_journal.path",
)(function* (journalDirectory: string, invocationKey: string) {
  const path = yield* Path.Path
  return path.join(journalDirectory, `${encodeURIComponent(invocationKey)}.json`)
})

// `output` has the exact type of OutputContract.schema, so the contract that
// validated the emit is the same codec that persists and replays the outcome.
export interface JournaledInvocation<O, E, R> {
  readonly journalDirectory: string
  readonly runId: string
  readonly invocationKey: string
  readonly output: Schema.Codec<O, O, never, never>
  readonly execute: Effect.Effect<AgentOutcome<O>, E, R>
}

// Replay a valid stored outcome, or pay the supplied invocation exactly once
// and persist its full outcome atomically. Missing, corrupt, or foreign
// artifacts are incomplete; other I/O failures remain visible (ADR 0003).
export const executeJournaledInvocation = Effect.fn(
  "gauntlet.invocation_journal.execute",
)(function* <O, E, R>({
  execute,
  invocationKey,
  journalDirectory,
  output,
  runId,
}: JournaledInvocation<O, E, R>) {
  const artifact = InvocationArtifact(output)
  const artifactPath = yield* invocationPath(journalDirectory, invocationKey)
  const text = yield* readOptionalArtifactText(artifactPath).pipe(
    Effect.mapError((cause) =>
      new InvocationJournalReadError({ path: artifactPath, cause })),
  )
  const stored = Option.flatMap(text, (source) =>
    Schema.decodeOption(Schema.fromJsonString(artifact))(source).pipe(
      Option.filter((entry) => entry.runId === runId),
    ))
  if (Option.isSome(stored)) {
    return { outcome: stored.value.outcome, reused: true }
  }

  const outcome = yield* execute
  yield* writeArtifactJson(artifactPath, artifact, {
    runId,
    invocationKey,
    outcome,
  })
  const checkpoint = yield* InvocationJournalCheckpoint
  yield* checkpoint(runId, invocationKey)
  return { outcome, reused: false }
})
