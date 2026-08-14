import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as TestConsole from "effect/testing/TestConsole"
import { Candidate } from "../../domain/candidate.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import { ReviewTarget } from "../../domain/review-target.ts"
import {
  makeScripted,
  type Scripted,
  scriptedLayer,
  type ScriptedSession,
  usageRow,
} from "../../harness/scripted.ts"
import { runPaths } from "../../run/run-record.ts"
import { executeJudgment } from "./judgment.ts"

const REPO_ROOT = "/fixture/repo"
const REVIEW_ROOT = "/fixture/review-worktree"

const target = ReviewTarget.cases.PullRequest.make({
  repoRoot: REPO_ROOT,
  number: 1,
  headCommit: "abc1234",
  baseCommit: "def5678",
  changedFiles: ["alpha.txt"],
  diff: "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1,2 @@\n first line\n+added-line\n",
  warnings: [],
})

const observations = globalThis.Array.from({ length: 2 }, (_, index) =>
  Candidate.cases.Observation.make({
    id: `fixture/${String(index + 1)}`,
    lens: "fixture",
    file: "alpha.txt",
    summary: `observation ${String(index + 1)}`,
  }))

const emittingSession = (
  output: unknown,
  valid = true,
  promptCount = 1,
): ScriptedSession => ({
  prompts: globalThis.Array.from({ length: promptCount }, () => ({
    events: [
      { afterMillis: 0, kind: "message_start" as const },
      { afterMillis: 0, kind: "emit" as const, args: output, valid },
      {
        afterMillis: 0,
        kind: "message_end" as const,
        stopReason: "toolUse" as const,
        usage: usageRow(),
      },
    ],
    settles: "after-events" as const,
  })),
})

const keepingSession = (): ScriptedSession =>
  emittingSession({
    decisions: [
      {
        index: 1,
        decision: "keep",
        tier: "P2",
        reason: "the call sites confirm the premise",
        goodFind: true,
        cleanlyExplained: true,
        merge: [2],
      },
    ],
  })

const runJudgment = (
  scripted: Scripted,
  seatless = false,
) =>
  Effect.gen(function* () {
    const plan: ReviewPlan = {
      runId: "judgment-test-run",
      target,
      seats: seatless
        ? {}
        : { judgment: "openai-codex/gpt-5.6-luna:low" },
      lenses: [],
    }
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const runsRoot = yield* fs.makeTempDirectoryScoped({
      prefix: "gauntlet-judgment-test-",
    })
    const paths = runPaths(runsRoot, plan.runId, path)
    yield* fs.makeDirectory(paths.journalDirectory, { recursive: true })
    const result = yield* executeJudgment({
      plan,
      paths,
      reviewWorkingDirectory: REVIEW_ROOT,
      observations,
    })
    return { result, journalPath: path.join(paths.journalDirectory, "judgment.json") }
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, scriptedLayer(scripted)),
    ),
  )

describe("Judgment stage interface", () => {
  it.effect("pays one journaled invocation against the shipped templates and resolves it", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({ sessions: [keepingSession()] })

      const { result, journalPath } = yield* runJudgment(scripted)

      expect(result.observations).toHaveLength(1)
      expect(result.observations[0]?.judgment).toMatchObject({
        _tag: "Kept",
        tier: "P2",
        mergedCandidateIds: ["fixture/2"],
      })
      expect(result.coverageGaps).toEqual([])
      expect(result.costUsd).toBe(0.05)
      expect(result.invocationCount).toBe(1)

      expect(scripted.configs).toHaveLength(1)
      expect(scripted.configs[0]?.seat).toBe("openai-codex/gpt-5.6-luna:low")
      expect(scripted.configs[0]?.cwd).toBe(REVIEW_ROOT)
      // Judgment stays host-backed until #58 migrates the evaluation stages.
      expect(scripted.configs[0]?.filesystem).toBe("host")
      expect(scripted.configs[0]?.sessionId).toBe("judgment-test-run-judgment")
      expect(scripted.configs[0]?.tools).toEqual(["read", "bash"])
      expect(scripted.configs[0]?.emitTool.name).toBe("emit_judgments")

      // The real shipped templates, asserted structurally: every placeholder
      // resolved, the candidate lines and scope block present — never wording.
      const [prompt = ""] = scripted.prompts.map(({ text }) => text)
      expect(prompt).not.toContain("{{")
      expect(prompt).toContain("## Candidates")
      expect(prompt).toContain("[1] (fixture) alpha.txt — observation 1")
      expect(prompt).toContain("[2] (fixture) alpha.txt — observation 2")
      expect(prompt).toContain("```diff")
      expect(prompt).toContain("+added-line")
      expect(prompt).toContain(REVIEW_ROOT)
      expect(prompt).not.toContain(REPO_ROOT)

      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(journalPath)).toBe(true)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain("gauntlet: invoking Judgment")
      expect(stderr).toContain("gauntlet: Judgment done — 0s · $0.05")
      expect(stderr).toContain(
        "gauntlet: Judgment finished — 1 kept · 0 dropped · 0 undecided · 0s",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("degrades to undecided with a coverage gap when the plan froze no judgment seat", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({ sessions: [] })

      const { result } = yield* runJudgment(scripted, true)

      expect(result.observations.map(({ judgment }) => judgment._tag)).toEqual([
        "Undecided",
        "Undecided",
      ])
      expect(result.coverageGaps).toEqual([
        {
          stage: "judgment",
          reason:
            "judgment has no seat frozen in the review plan; retained every observation as undecided",
        },
      ])
      expect(result.costUsd).toBe(0)
      expect(result.invocationCount).toBe(0)
      expect(scripted.configs).toHaveLength(0)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "gauntlet: coverage gap — judgment has no seat frozen in the review plan; retained every observation as undecided",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps an off-spec emit visible as undecided with the missing-output reason", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          emittingSession(
            {
              decisions: [{
                index: 1,
                decision: "keep",
                reason: "missing the required keep fields",
              }],
            },
            false,
            3,
          ),
        ],
      })

      const { result } = yield* runJudgment(scripted)

      expect(result.observations.map(({ judgment }) => judgment._tag)).toEqual([
        "Undecided",
        "Undecided",
      ])
      expect(result.coverageGaps).toEqual([
        {
          stage: "judgment",
          reason: "judgment emitted nothing after 2 corrective turns",
        },
      ])
      expect(result.invocationCount).toBe(1)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "gauntlet: coverage gap — judgment emitted nothing after 2 corrective turns",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
