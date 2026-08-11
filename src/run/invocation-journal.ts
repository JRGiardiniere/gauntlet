import * as Effect from "effect/Effect"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { AgentOutcome } from "../domain/agent-outcome.ts"
import { FindingsOutput } from "../harness/output-contract.ts"
import { writeArtifactJson } from "./artifact.ts"

export const FinderInvocationArtifact = Schema.Struct({
  runId: Schema.NonEmptyString,
  invocationKey: Schema.NonEmptyString,
  lens: Schema.NonEmptyString,
  outcome: AgentOutcome(FindingsOutput),
})
export interface FinderInvocationArtifact
  extends Schema.Schema.Type<typeof FinderInvocationArtifact> {}

export const writeFinderInvocation = Effect.fn(
  "gauntlet.invocation_journal.write_finder",
)(function* (journalDirectory: string, artifact: FinderInvocationArtifact) {
  const path = yield* Path.Path
  const artifactPath = path.join(
    journalDirectory,
    `${artifact.invocationKey}.json`,
  )
  yield* writeArtifactJson(artifactPath, FinderInvocationArtifact, artifact)
  return artifactPath
})
