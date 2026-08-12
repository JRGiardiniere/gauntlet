import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { type AgentOutcome, Termination } from "../domain/agent-outcome.ts"
import { type PoolOutput as PoolOutputType, PoolOutput } from "../harness/output-contract.ts"
import {
  executeJournaledInvocation,
  InvocationArtifact,
} from "./invocation-journal.ts"

const POOL_OUTCOME: AgentOutcome<PoolOutputType> = {
  termination: Termination.cases.Completed.make({}),
  output: { clusters: [{ indexes: [1], summary: "one cluster" }] },
  usage: {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    reasoning: 0,
    costUsd: 0,
    rawRows: [],
  },
  durationMillis: 0,
  diagnostics: [],
}

const journaled = (
  journalDirectory: string,
  runId: string,
  execute: Effect.Effect<AgentOutcome<PoolOutputType>>,
) =>
  executeJournaledInvocation({
    journalDirectory,
    runId,
    invocationKey: "pool/stage",
    output: PoolOutput,
    execute,
  })

describe("executeJournaledInvocation", () => {
  it.effect("journals a non-finder output schema and replays without re-paying", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const journalDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "gauntlet-journal-test-",
      })
      let paid = 0
      const run = journaled(
        journalDirectory,
        "run-a",
        Effect.sync(() => {
          paid += 1
          return POOL_OUTCOME
        }),
      )

      const first = yield* run
      expect(first.reused).toBe(false)
      expect(paid).toBe(1)

      const replay = yield* run
      expect(replay.reused).toBe(true)
      expect(replay.outcome.output).toEqual(POOL_OUTCOME.output)
      expect(paid).toBe(1)

      const text = yield* fs.readFileString(
        path.join(journalDirectory, "pool%2Fstage.json"),
      )
      const stored = yield* Schema.decodeEffect(
        Schema.fromJsonString(InvocationArtifact(PoolOutput)),
      )(text)
      expect(stored.runId).toBe("run-a")
      expect(stored.outcome.termination._tag).toBe("Completed")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("re-invokes corrupt journal files instead of adopting them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const journalDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "gauntlet-journal-corrupt-",
      })
      const artifactPath = path.join(journalDirectory, "pool%2Fstage.json")
      yield* fs.writeFileString(artifactPath, "{not valid json\n")

      let paid = 0
      const result = yield* journaled(
        journalDirectory,
        "run-a",
        Effect.sync(() => {
          paid += 1
          return POOL_OUTCOME
        }),
      )

      expect(result.reused).toBe(false)
      expect(paid).toBe(1)
      const stored = yield* Schema.decodeEffect(
        Schema.fromJsonString(InvocationArtifact(PoolOutput)),
      )(yield* fs.readFileString(artifactPath))
      expect(stored.runId).toBe("run-a")
      expect(stored.outcome.output).toEqual(POOL_OUTCOME.output)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("re-invokes foreign journal files instead of adopting them", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const journalDirectory = yield* fs.makeTempDirectoryScoped({
        prefix: "gauntlet-journal-foreign-",
      })
      const artifactPath = path.join(journalDirectory, "pool%2Fstage.json")
      const foreign = yield* Schema.encodeEffect(
        Schema.fromJsonString(InvocationArtifact(PoolOutput)),
      )({
        runId: "foreign-run",
        invocationKey: "pool/stage",
        outcome: POOL_OUTCOME,
      })
      yield* fs.writeFileString(artifactPath, `${foreign}\n`)

      let paid = 0
      const result = yield* journaled(
        journalDirectory,
        "run-a",
        Effect.sync(() => {
          paid += 1
          return {
            ...POOL_OUTCOME,
            output: { clusters: [{ indexes: [2], summary: "repaid" }] },
          }
        }),
      )

      expect(result.reused).toBe(false)
      expect(paid).toBe(1)
      expect(result.outcome.output).toEqual({
        clusters: [{ indexes: [2], summary: "repaid" }],
      })
      const stored = yield* Schema.decodeEffect(
        Schema.fromJsonString(InvocationArtifact(PoolOutput)),
      )(yield* fs.readFileString(artifactPath))
      expect(stored.runId).toBe("run-a")
      expect(stored.outcome.output).toEqual({
        clusters: [{ indexes: [2], summary: "repaid" }],
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
