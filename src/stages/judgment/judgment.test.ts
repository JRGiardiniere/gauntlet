import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Candidate } from "../../domain/candidate.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import {
  makeScripted,
  type Scripted,
  scriptedLayer,
  type ScriptedSession,
  usageRow,
} from "../../harness/scripted.ts"
import { runPaths } from "../../run/run-record.ts"
import { resolveWorkingTreeTarget } from "../../target/working-tree.ts"
import { executeJudgment } from "./judgment.ts"

const git = (cwd: string, ...args: Array<string>) => {
  execFileSync("git", args, { cwd, stdio: "pipe" })
}

interface Fixture {
  readonly repo: string
  readonly runsRoot: string
}

// The stage seam still reviews a real working tree: the target is frozen from
// an actual dirty repo, and prompts assemble from the shipped templates.
const makeFixture = (): Fixture => {
  // git resolves /var → /private/var on macOS; realpath keeps the frozen
  // target's repoRoot equal to the fixture's own paths.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gauntlet-judgment-test-")))
  const repo = join(root, "repo")
  mkdirSync(repo, { recursive: true })
  git(repo, "init")
  writeFileSync(join(repo, "alpha.txt"), "first line\n")
  git(repo, "add", "--all")
  git(
    repo,
    "-c",
    "user.name=gauntlet-test",
    "-c",
    "user.email=gauntlet-test@example.invalid",
    "commit",
    "--message",
    "initial",
  )
  writeFileSync(join(repo, "alpha.txt"), "first line\nadded-line\n")
  return { repo, runsRoot: join(root, "runs") }
}

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
  fixture: Fixture,
  scripted: Scripted,
  seatless = false,
) =>
  Effect.gen(function* () {
    const target = yield* resolveWorkingTreeTarget(fixture.repo)
    const plan: ReviewPlan = {
      runId: "judgment-test-run",
      createdAt: "2026-08-12T00:00:00Z",
      target,
      seats: seatless
        ? {}
        : { judgment: "openai-codex/gpt-5.6-luna:low" },
      lenses: [],
    }
    const path = yield* Path.Path
    const paths = runPaths(fixture.runsRoot, plan.runId, path)
    const fs = yield* FileSystem.FileSystem
    yield* fs.makeDirectory(paths.journalDirectory, { recursive: true })
    return yield* executeJudgment({ plan, paths, observations })
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, scriptedLayer(scripted)),
    ),
  )

describe("Judgment stage interface", () => {
  it.effect("pays one journaled invocation against the shipped templates and resolves it", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      const scripted = makeScripted({ sessions: [keepingSession()] })

      const result = yield* runJudgment(fixture, scripted)

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
      expect(scripted.configs[0]?.cwd).toBe(fixture.repo)
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
      expect(prompt).toContain(fixture.repo)

      const fs = yield* FileSystem.FileSystem
      expect(
        yield* fs.exists(
          join(fixture.runsRoot, "judgment-test-run", "journal", "judgment.json"),
        ),
      ).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("surfaces sanitized decisions as a repair coverage gap with every candidate accounted", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      const scripted = makeScripted({
        sessions: [
          emittingSession({
            decisions: [
              {
                index: 1,
                decision: "keep",
                tier: "P2",
                reason: "the call sites confirm the premise",
                goodFind: true,
                cleanlyExplained: true,
                merge: [1, 2],
              },
            ],
          }),
        ],
      })

      const result = yield* runJudgment(fixture, scripted)

      expect(result.coverageGaps).toEqual([
        {
          stage: "judgment",
          reason: "judgment output required repair: ignored self-merges of indexes 1",
        },
      ])
      const accounted = result.observations.flatMap(({ candidate, judgment }) => [
        candidate.id,
        ...(judgment._tag === "Kept" ? judgment.mergedCandidateIds : []),
      ])
      expect(accounted.sort()).toEqual(["fixture/1", "fixture/2"])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("replays the journaled outcome instead of paying a second invocation", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      const paid = yield* runJudgment(
        fixture,
        makeScripted({ sessions: [keepingSession()] }),
      )

      const replayScripted = makeScripted({ sessions: [] })
      const replayed = yield* runJudgment(fixture, replayScripted)

      expect(replayed).toEqual(paid)
      expect(replayScripted.configs).toHaveLength(0)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("degrades to undecided with a coverage gap when the plan froze no judgment seat", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      const scripted = makeScripted({ sessions: [] })

      const result = yield* runJudgment(fixture, scripted, true)

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
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps an off-spec emit visible as undecided with the missing-output reason", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
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

      const result = yield* runJudgment(fixture, scripted)

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
    }).pipe(Effect.provide(NodeServices.layer)))
})
