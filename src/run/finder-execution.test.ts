import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
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
import { EmitFindings } from "../harness/output-contract.ts"
import {
  makeScripted,
  type Scripted,
  scriptedLayer,
  ScriptedEnding,
  type ScriptedSession,
} from "../harness/scripted.ts"
import { FINDER_FOLLOWER_WAIT_MILLIS } from "./invocation-policy.ts"
import {
  executeFinders,
  FinderCacheSettle,
  FinderCacheSettleDelay,
  FinderStageArtifact,
} from "./finder-execution.ts"
import { runPaths } from "./run-record.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"

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
  turns: [{ emits: [{ findings: [] }] }],
})

const specification: ReviewSpecification = {
  provenance: "finder execution test",
  text: "SPECIFICATION-NEEDLE: preserve stable ordering",
}

const executeFixture = (
  lenses: ReadonlyArray<FrozenLens>,
  scripted: Scripted,
  options: {
    readonly specification?: ReviewSpecification
    readonly settle?: Effect.Effect<void>
    // A snapshot to gather the related-file context from.
    readonly relatedFiles?: {
      readonly snapshot: string
      readonly changedFiles: ReadonlyArray<string>
    }
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
      "fixture finder system prompt, emitting with {{EMIT_TOOL}}\n",
    )
    yield* fs.writeFileString(
      path.join(content, "prompts", "finder-shared-block.md"),
      "shared start\nrepo={{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}\n{{WORKSPACE_TOOLS}}\ncap={{MAX_PER_LENS}}\nshared end\n",
    )
    yield* fs.writeFileString(
      path.join(content, "prompts", "workspace.md"),
      "fixture workspace tools at {{REPO_ROOT}}\n",
    )
    yield* fs.writeFileString(
      path.join(content, "prompts", "workspace-codemode-readonly.md"),
      "fixture codemode readonly tools at {{REPO_ROOT}}\n",
    )
    yield* fs.writeFileString(
      path.join(content, "prompts", "finder-related-files.md"),
      "touched:\n{{TOUCHED_FILES}}\nrelated:\n{{RELATED_FILES}}\n",
    )
    const runId = "finder-execution-test"

    const planCore = {
      runId,
      target: ReviewTarget.cases.PullRequest.make({
        repoRoot: "/fixture/repo",
        number: 79,
        headCommit: "head",
        baseCommit: "base",
        changedFiles: options.relatedFiles?.changedFiles ?? ["alpha.txt"],
        diff: "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1,2 @@\n base\n+change\n",
        warnings: [],
      }),
      seats: {},
      lenses,
    }

    const specified = ReviewPlan.make(
      options.specification === undefined
        ? planCore
        : { ...planCore, specification: options.specification },
    )

    const plan = options.relatedFiles === undefined
      ? specified
      : ReviewPlan.make({ ...specified, relatedFiles: true })

    const paths = runPaths(path.join(root, "runs"), runId, path)
    yield* fs.makeDirectory(paths.root, { recursive: true })

    const effect = executeFinders({
      plan,
      paths,
      reviewWorkingDirectory: options.relatedFiles?.snapshot ??
        path.join(root, "review"),
    }).pipe(
      Effect.provideService(FinderCacheSettle, options.settle ?? Effect.void),
      Effect.provide([
        NodeServices.layer,
        scriptedLayer(scripted),
        Layer.succeed(ContentDirectory, content),
      ]),
    )

    return { effect, fs, paths, plan }
  }).pipe(Effect.provide(NodeServices.layer))

describe("Finder stage interface", () => {
  it.effect("shares touched files whole and their importers and imports when the plan froze related files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { repo } = yield* makeGitFixture()

      const write = (file: string, text: string) =>
        fs.writeFileString(path.join(repo, file), text)

      yield* write("touched.ts", `import { helper } from "./helper.ts"\nTOUCHED-BODY\n`)
      yield* write("helper.ts", "HELPER-BODY\n")
      yield* write("touched.test.ts", `import "./touched"\nTEST-BODY\n`)
      yield* write("uses-gone.ts", `export * from "./gone.js"\nUSES-GONE-BODY\n`)
      yield* write("added-dep.ts", "ADDED-DEP-BODY\n")
      yield* write("unrelated.ts", `import "./helper.ts"\nUNRELATED-BODY\n`)
      yield* write("locked.ts", "LOCKED-BODY\n")
      yield* commitAll(repo, "fixture")
      // Untracked, as a working-tree overlay leaves a new file.
      yield* write("added.ts", `import "./added-dep.ts"\nADDED-BODY\n`)
      // A file that cannot be read is skipped, not a failed run.
      yield* fs.chmod(path.join(repo, "locked.ts"), 0o000)
      const scripted = makeScripted({ sessions: [successfulSession("one")] })

      const fixture = yield* executeFixture([lens("one", "one tail")], scripted, {
        relatedFiles: {
          snapshot: repo,
          changedFiles: ["touched.ts", "added.ts", "gone.ts", "locked.ts"],
        },
      })

      yield* fixture.effect

      const systemPrompt = scripted.specs[0]?.systemPrompt ?? ""
      const [touched = "", related = ""] = systemPrompt.split("related:")
      expect(touched).toContain("### touched.ts")
      expect(touched).toContain("TOUCHED-BODY")
      expect(touched).toContain("ADDED-BODY")
      expect(touched).not.toContain("### gone.ts")
      expect(touched).not.toContain("### locked.ts")
      expect(Array.map([...related.matchAll(/^### (\S+)$/gm)], ([, file]) => file))
        .toEqual(["added-dep.ts", "helper.ts", "touched.test.ts", "uses-gone.ts"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("partitions by Seat/context and gives every Finder the complete shared prefix", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          successfulSession("standard-one"),
          successfulSession("standard-two"),
          successfulSession("interpretive-one"),
          successfulSession("interpretive-two"),
          successfulSession("other-seat"),
        ],
      })

      const fixture = yield* executeFixture(
        [
          lens("standard-one", "standard one tail"),
          lens("standard-two", "standard two tail"),
          lens("interpretive-one", "interpretive one tail", "interpretive"),
          lens("interpretive-two", "interpretive two tail", "interpretive"),
          { ...lens("other-seat", "other seat tail"), seat: "fixture/other-model:low" },
        ],
        scripted,
        { specification },
      )

      const result = yield* fixture.effect

      expect(result.finders).toHaveLength(5)
      expect(new Set(Array.map(scripted.specs, ({ cacheGroup }) => cacheGroup)).size).toBe(3)
      expect(new Set(Array.map(scripted.specs, ({ role }) => role))).toEqual(new Set(["finder-1", "finder-2", "finder-3"]))

      for (const selectedLens of fixture.plan.lenses) {
        const prompt = Array.findFirst(scripted.prompts, ({ invocationId }) =>
          invocationId.endsWith(`-finder-${selectedLens.name}`))

        expect(Option.exists(prompt, ({ text }) => text.endsWith(`\n\n${selectedLens.promptText}`))).toBe(true)
      }

      for (const role of ["finder-1", "finder-2"]) {
        const specs = Array.filter(scripted.specs, (spec) => spec.role === role)
        expect(specs).toHaveLength(2)
        expect(specs[1]?.cacheGroup).toBe(specs[0]?.cacheGroup)
        // The key and prefix are the change's, not the Run's or snapshot's.
        expect(specs[0]?.cacheGroup).not.toContain(fixture.plan.runId)
        expect(specs[0]?.systemPrompt).not.toContain(specs[0]?.workspace ?? "")
        expect(specs[1]?.systemPrompt).toBe(specs[0]?.systemPrompt)
        expect(specs[1]?.tools).toEqual(specs[0]?.tools)
        expect(specs[1]?.emit).toMatchObject({
          name: specs[0]?.emit.name,
          description: specs[0]?.emit.description,
          parameters: specs[0]?.emit.parameters,
        })
      }

      // The shared block lives in the system prompt (provider instructions);
      // the user message is only the lens tail.
      const systemPromptFor = (fragment: string) =>
        pipe(
          scripted.prompts,
          Array.filter(({ invocationId }) => invocationId.includes(fragment)),
          Array.map(({ openIndex }) => scripted.specs[openIndex - 1]?.systemPrompt),
        )

      const standardSystemPrompts = systemPromptFor("standard-")
      const interpretiveSystemPrompts = systemPromptFor("interpretive-")
      expect(standardSystemPrompts).toHaveLength(2)
      expect(interpretiveSystemPrompts).toHaveLength(2)

      for (const [first, second] of [standardSystemPrompts, interpretiveSystemPrompts]) {
        expect(first).toBe(second)
        expect(first).toContain("shared start")
      }

      expect(standardSystemPrompts[0]).toContain(
        `emitting with ${EmitFindings.toolName}\n`,
      )
      expect(standardSystemPrompts[0]).not.toContain("{{")
      expect(standardSystemPrompts[0]).not.toContain("SPECIFICATION-NEEDLE")
      expect(interpretiveSystemPrompts[0]).toContain("SPECIFICATION-NEEDLE")

      for (const { text } of scripted.prompts) {
        expect(text).not.toContain("shared start")
      }

      const artifact = yield* fixture.fs.readFileString(
        fixture.paths.finderStage,
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(FinderStageArtifact)),
        ),
      )

      expect(Array.map(artifact.finders, ({ invocationKey }) => invocationKey)).toEqual([
        "finder-standard-one",
        "finder-standard-two",
        "finder-interpretive-one",
        "finder-interpretive-two",
        "finder-other-seat",
      ])
    }).pipe(Effect.scoped))

  const pair = [lens("standard-one", "standard one tail"), lens("standard-two", "standard two tail")]

  it.effect("launches followers 1500ms after the starter's first token, while the starter is still running", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          { forSession: "standard-one", firstTokenAfterMillis: 0, turns: [{ afterMillis: 10_000, emits: [{ findings: [] }] }] },
          successfulSession("standard-two"),
        ],
      })

      const prefixObserved = yield* Deferred.make<void>()

      const fixture = yield* executeFixture(pair, scripted, {
        settle: Deferred.succeed(prefixObserved, undefined).pipe(Effect.andThen(FinderCacheSettleDelay)),
      })

      const fiber = yield* Effect.forkChild(fixture.effect)

      yield* Deferred.await(prefixObserved)
      expect(scripted.specs).toHaveLength(1)
      yield* TestClock.adjust("1499 millis")
      expect(scripted.specs).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      expect(scripted.specs).toHaveLength(2)
      expect(scripted.log).not.toContain("close:1")

      yield* TestClock.adjust("10 seconds")
      expect((yield* Fiber.join(fiber)).finders).toHaveLength(2)
    }).pipe(Effect.scoped))

  it.effect("launches followers at once, with no settle, when the starter ends before a first token", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          {
            forSession: "standard-one",
            firstTokenAfterMillis: "never",
            turns: [{ afterMillis: 1_000, ending: ScriptedEnding.ProviderFailed({ reason: "down" }) }],
          },
          successfulSession("standard-two"),
        ],
      })

      const settled = yield* Deferred.make<void>()
      const fixture = yield* executeFixture(pair, scripted, { settle: Deferred.succeed(settled, undefined) })
      const fiber = yield* Effect.forkChild(fixture.effect)

      yield* scripted.opened(1)
      yield* TestClock.adjust("999 millis")
      expect(scripted.specs).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      const result = yield* Fiber.join(fiber)
      expect(scripted.specs).toHaveLength(2)
      const settledEarly = yield* Deferred.isDone(settled)
      expect(settledEarly).toBe(false)
      expect(Array.map(result.finders, ({ outcome }) => outcome.termination._tag)).toEqual(["ProviderFailed", "Completed"])
    }).pipe(Effect.scoped))

  it.effect("bounds the followers' wait for a stalled starter, then runs them beside it", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          {
            forSession: "standard-one",
            firstTokenAfterMillis: "never",
            turns: [{ afterMillis: 200_000, emits: [{ findings: [] }] }],
          },
          successfulSession("standard-two"),
        ],
      })

      const settled = yield* Deferred.make<void>()
      const fixture = yield* executeFixture(pair, scripted, { settle: Deferred.succeed(settled, undefined) })
      const fiber = yield* Effect.forkChild(fixture.effect)

      yield* scripted.opened(1)
      yield* TestClock.adjust(Duration.millis(FINDER_FOLLOWER_WAIT_MILLIS - 1))
      expect(scripted.specs).toHaveLength(1)
      yield* TestClock.adjust("1 millis")
      expect(scripted.specs).toHaveLength(2)
      expect(scripted.log).not.toContain("close:1")
      const settledEarly = yield* Deferred.isDone(settled)
      expect(settledEarly).toBe(false)

      yield* TestClock.adjust("200 seconds")
      const joined = yield* Fiber.join(fiber)
      expect(Array.map(joined.finders, ({ outcome }) => outcome.termination._tag))
        .toEqual(["Completed", "Completed"])
    }).pipe(Effect.scoped))

  it.effect("launches each follower once when the starter fails before metered usage", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          {
            forSession: "standard-one",
            failOpen: "provider unavailable",
            turns: [],
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

      const setupFailure = yield* Effect.flip(fixture.effect)
      expect(setupFailure).toBeInstanceOf(InvocationSetupError)
      expect(scripted.specs).toHaveLength(2)
      expect(scripted.prompts).toHaveLength(1)
      expect(scripted.prompts[0]?.text).toContain("standard two tail")
    }).pipe(Effect.scoped))
})
