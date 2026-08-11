import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { AgentOutcome } from "../domain/agent-outcome.ts"
import type { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { FindingsOutput } from "../harness/output-contract.ts"
import { readOptionalArtifactText, writeArtifactJson } from "./artifact.ts"

export const FinderInvocationArtifact = Schema.Struct({
  runId: Schema.NonEmptyString,
  invocationKey: Schema.NonEmptyString,
  lens: Schema.NonEmptyString,
  outcome: AgentOutcome(FindingsOutput),
})
export interface FinderInvocationArtifact
  extends Schema.Schema.Type<typeof FinderInvocationArtifact> {}

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

export const finderInvocationsInPlan = (
  plan: ReviewPlan,
): ReadonlyArray<FrozenFinderInvocation> =>
  plan.lenses.map((lens) => ({
    invocationKey: `finder-${lens.name}`,
    lens,
  }))

const finderInvocationPath = Effect.fn(
  "gauntlet.invocation_journal.finder_path",
)(function* (journalDirectory: string, invocationKey: string) {
  const path = yield* Path.Path
  return path.join(journalDirectory, `${invocationKey}.json`)
})

export const writeFinderInvocation = Effect.fn(
  "gauntlet.invocation_journal.write_finder",
)(function* (journalDirectory: string, artifact: FinderInvocationArtifact) {
  const artifactPath = yield* finderInvocationPath(
    journalDirectory,
    artifact.invocationKey,
  )
  yield* writeArtifactJson(artifactPath, FinderInvocationArtifact, artifact)
  return artifactPath
})

// Missing, corrupt, or foreign artifacts are incomplete; other I/O failures
// remain visible (ADR 0003).
export const readFinderInvocation = Effect.fn(
  "gauntlet.invocation_journal.read_finder",
)(function* (
  journalDirectory: string,
  runId: string,
  invocationKey: string,
) {
  const artifactPath = yield* finderInvocationPath(
    journalDirectory,
    invocationKey,
  )
  const text = yield* readOptionalArtifactText(artifactPath).pipe(
    Effect.mapError((cause) =>
      new InvocationJournalReadError({ path: artifactPath, cause })),
  )

  return Option.flatMap(text, (source) =>
    Schema.decodeOption(
      Schema.fromJsonString(FinderInvocationArtifact),
    )(source).pipe(
      Option.filter((artifact) => artifact.runId === runId),
    ))
})
