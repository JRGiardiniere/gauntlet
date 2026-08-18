import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as TestClock from "effect/testing/TestClock"
import { ContentDirectory } from "../content/lens.ts"
import {
  DEFAULT_CANDIDATE_CAP,
  type FrozenLens,
  ReviewPlan,
} from "../domain/review-plan.ts"
import type { ReviewSpecification } from "../domain/review-specification.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { InvocationSetupError } from "../harness/harness-session.ts"
import {
  makeScripted,
  type Scripted,
  scriptedLayer,
  type ScriptedSession,
  usageRow,
} from "../harness/scripted.ts"
import {
  executeFinders,
  FinderCacheSettle,
  FinderCacheSettleDelay,
  FinderStageArtifact,
} from "./finder-execution.ts"
import { measureFinderCacheHealth } from "./finder-cache-health.ts"
import { runPaths } from "./run-record.ts"

const SEAT = "fixture/fixture-model:low" as const

const lens = (
  name: string,
  promptText: string,
  finderClass?: "interpretive",
): FrozenLens => {
  const core = {
    name,
    promptText,
    seat: SEAT,
    candidateCap: DEFAULT_CANDIDATE_CAP,
  }
  return finderClass === undefined ? core : { ...core, finderClass }
}

const successfulSession = (forSession: string): ScriptedSession => ({
  forSession,
  prompts: [{
    events: [
      { afterMillis: 0, kind: "message_start" },
      {
        afterMillis: 0,
        kind: "emit",
        args: { findings: [] },
        valid: true,
      },
      {
        afterMillis: 0,
        kind: "message_end",
        stopReason: "toolUse",
        usage: usageRow(),
      },
    ],
    settles: "after-events",
  }],
})

const successfulSessionWithUsage = (
  forSession: string,
  input: number,
  cacheRead: number,
): ScriptedSession => ({
  forSession,
  prompts: [{
    events: [
      { afterMillis: 0, kind: "message_start" },
      {
        afterMillis: 0,
        kind: "emit",
        args: { findings: [] },
        valid: true,
      },
      {
        afterMillis: 0,
        kind: "message_end",
        stopReason: "toolUse",
        usage: usageRow({ input, cacheRead }),
      },
    ],
    settles: "after-events",
  }],
})

const specification: ReviewSpecification = {
  documents: [{
    role: "caller-addendum",
    provenance: "finder execution test",
    text: "SPECIFICATION-NEEDLE: preserve stable ordering",
  }],
  comments: [],
}

const executeFixture = (
  lenses: ReadonlyArray<FrozenLens>,
  scripted: Scripted,
  options: {
    readonly specification?: ReviewSpecification
    readonly settle?: Effect.Effect<void>
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({
      prefix: "gauntlet-finder-execution-test-",
    })
    const content = path.join(root, "content")
    yield* fs.makeDirectory(path.join(content, "prompts"), { recursive: true })
    yield* fs.writeFileString(
      path.join(content, "prompts", "finder-system.md"),
      "fixture finder system prompt\n",
    )
    yield* fs.writeFileString(
      path.join(content, "prompts", "finder-shared-block.md"),
      "shared start\nrepo={{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}\ncap={{MAX_PER_LENS}}\nshared end\n",
    )
    const runId = "finder-execution-test"
    const planCore = {
      runId,
      target: ReviewTarget.cases.PullRequest.make({
        repoRoot: "/fixture/repo",
        number: 79,
        headCommit: "head",
        baseCommit: "base",
        changedFiles: ["alpha.txt"],
        diff: "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1,2 @@\n base\n+change\n",
        warnings: [],
      }),
      seats: {},
      lenses,
    }
    const plan = ReviewPlan.make(
      options.specification === undefined
        ? planCore
        : { ...planCore, specification: options.specification },
    )
    const paths = runPaths(path.join(root, "runs"), runId, path)
    yield* fs.makeDirectory(paths.root, { recursive: true })
    const effect = executeFinders({
      plan,
      paths,
      reviewWorkingDirectory: path.join(root, "review"),
    }).pipe(
      Effect.provideService(FinderCacheSettle, options.settle ?? Effect.void),
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          scriptedLayer(scripted),
          Layer.succeed(ContentDirectory, content),
        ),
      ),
    )
    return { effect, fs, paths, plan }
  }).pipe(Effect.provide(NodeServices.layer))

describe("Finder stage interface", () => {
  it.effect("partitions by Seat/context and gives every Finder the complete shared prefix", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          successfulSession("standard-one"),
          successfulSession("standard-two"),
          successfulSession("interpretive-one"),
          successfulSession("interpretive-two"),
        ],
      })
      const fixture = yield* executeFixture(
        [
          lens("standard-one", "standard one tail"),
          lens("standard-two", "standard two tail"),
          lens("interpretive-one", "interpretive one tail", "interpretive"),
          lens("interpretive-two", "interpretive two tail", "interpretive"),
        ],
        scripted,
        { specification },
      )

      const result = yield* fixture.effect

      expect(result.finders).toHaveLength(4)
      for (const suffix of ["-finders-1", "-finders-2"]) {
        const configs = scripted.configs.filter(
          ({ cacheGroupId }) => cacheGroupId?.includes(suffix) ?? false,
        )
        expect(configs).toHaveLength(2)
        expect(configs[1]?.systemPrompt).toBe(configs[0]?.systemPrompt)
        expect(configs[1]?.tools).toEqual(configs[0]?.tools)
        expect(configs[1]?.emitTool).toMatchObject({
          name: configs[0]?.emitTool.name,
          description: configs[0]?.emitTool.description,
          parameters: configs[0]?.emitTool.parameters,
        })
      }
      const standardPrompts = scripted.prompts.filter(({ invocationId }) =>
        invocationId.includes("standard-"))
      const interpretivePrompts = scripted.prompts.filter(({ invocationId }) =>
        invocationId.includes("interpretive-"))
      for (const { text } of standardPrompts) {
        expect(text).toContain("shared start")
        expect(text).not.toContain("SPECIFICATION-NEEDLE")
      }
      for (const { text } of interpretivePrompts) {
        expect(text).toContain("shared start")
        expect(text).toContain("SPECIFICATION-NEEDLE")
      }

      const artifact = yield* fixture.fs.readFileString(
        fixture.paths.finderStage,
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(FinderStageArtifact)),
        ),
      )
      expect(artifact.finders.map(({ invocationKey }) => invocationKey)).toEqual([
        "finder-standard-one",
        "finder-standard-two",
        "finder-interpretive-one",
        "finder-interpretive-two",
      ])
    }).pipe(Effect.scoped))

  it.effect("launches followers at 1500ms while the ordinary starter remains active", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          {
            forSession: "standard-one",
            prompts: [
              {
                events: [
                  { afterMillis: 0, kind: "message_start" },
                  { afterMillis: 0, kind: "message_end", stopReason: "stop" },
                ],
                settles: "after-events",
              },
              {
                events: [
                  { afterMillis: 0, kind: "message_start" },
                  {
                    afterMillis: 5_000,
                    kind: "emit",
                    args: { findings: [] },
                    valid: true,
                  },
                  {
                    afterMillis: 5_000,
                    kind: "message_end",
                    stopReason: "toolUse",
                  },
                ],
                settles: "after-events",
              },
            ],
          },
          successfulSession("standard-two"),
        ],
      })
      const prefixObserved = yield* Deferred.make<void>()
      const fixture = yield* executeFixture(
        [
          lens("standard-one", "standard one tail"),
          lens("standard-two", "standard two tail"),
        ],
        scripted,
        {
          settle: Deferred.succeed(prefixObserved, undefined).pipe(
            Effect.andThen(FinderCacheSettleDelay),
          ),
        },
      )
      const fiber = yield* Effect.forkChild(fixture.effect)

      yield* Deferred.await(prefixObserved)
      expect(scripted.configs).toHaveLength(1)
      yield* TestClock.adjust("1499 millis")
      yield* Effect.yieldNow
      expect(scripted.configs).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      yield* Effect.yieldNow
      expect(scripted.configs).toHaveLength(2)
      expect(scripted.log).not.toContain("dispose:1")

      yield* TestClock.adjust("5 seconds")
      expect((yield* Fiber.join(fiber)).finders).toHaveLength(2)
    }).pipe(Effect.scoped))

  it.effect("derives the same cache health after reusing a completed Finder checkpoint", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          successfulSessionWithUsage("standard-one", 100, 0),
          successfulSessionWithUsage("standard-two", 100, 0),
          successfulSessionWithUsage("standard-three", 80, 20),
        ],
      })
      const fixture = yield* executeFixture(
        [
          lens("standard-one", "standard one tail"),
          lens("standard-two", "standard two tail"),
          lens("standard-three", "standard three tail"),
        ],
        scripted,
      )

      const first = yield* fixture.effect
      const firstHealth = measureFinderCacheHealth(
        fixture.plan,
        first.finders,
      )
      const resumed = yield* fixture.effect

      expect(measureFinderCacheHealth(
        fixture.plan,
        resumed.finders,
      )).toEqual(firstHealth)
      expect(firstHealth).toEqual([expect.objectContaining({ reuse: 0.1 })])
      expect(scripted.configs).toHaveLength(3)
    }).pipe(Effect.scoped))

  it.effect("launches each follower once when the starter fails before metered usage", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          {
            forSession: "standard-one",
            failOpen: "provider unavailable",
            prompts: [],
          },
          successfulSession("standard-two"),
        ],
      })
      const fixture = yield* executeFixture(
        [
          lens("standard-one", "standard one tail"),
          lens("standard-two", "standard two tail"),
        ],
        scripted,
      )

      expect(yield* Effect.flip(fixture.effect)).toBeInstanceOf(
        InvocationSetupError,
      )
      expect(scripted.configs).toHaveLength(2)
      expect(scripted.prompts).toHaveLength(1)
      expect(scripted.prompts[0]?.text).toContain("standard two tail")
    }).pipe(Effect.scoped))
})
