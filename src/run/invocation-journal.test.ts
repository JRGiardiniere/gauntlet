import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type AgentOutcome, Termination } from "../domain/agent-outcome.ts"
import { type PoolOutput as PoolOutputType, PoolOutput } from "../harness/output-contract.ts"
import {
  executeJournaledInvocation,
  InvocationArtifact,
} from "./invocation-journal.ts"

// CLI-seam tests own replay/corrupt/foreign behavior for the finder stage;
// this proves only that the primitive is parameterized by stage output schema.
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

describe("executeJournaledInvocation", () => {
  it.effect("journals a non-finder output schema and replays without re-paying", () =>
    Effect.gen(function* () {
      const journalDirectory = mkdtempSync(
        join(tmpdir(), "gauntlet-journal-test-"),
      )
      let paid = 0
      const run = executeJournaledInvocation({
        journalDirectory,
        runId: "run-a",
        invocationKey: "pool",
        output: PoolOutput,
        execute: Effect.sync(() => {
          paid += 1
          return POOL_OUTCOME
        }),
      })

      const first = yield* run
      expect(first.reused).toBe(false)
      expect(paid).toBe(1)

      const replay = yield* run
      expect(replay.reused).toBe(true)
      expect(replay.outcome.output).toEqual(POOL_OUTCOME.output)
      expect(paid).toBe(1)

      const fs = yield* FileSystem.FileSystem
      const text = yield* fs.readFileString(join(journalDirectory, "pool.json"))
      const stored = yield* Schema.decodeEffect(
        Schema.fromJsonString(InvocationArtifact(PoolOutput)),
      )(text)
      expect(stored.runId).toBe("run-a")
      expect(stored.outcome.termination._tag).toBe("Completed")
    }).pipe(Effect.provide(NodeServices.layer)))
})
