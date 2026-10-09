import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Candidate } from "../../domain/candidate.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import { ReviewTarget } from "../../domain/review-target.ts"
import {
  makeScripted,
  type Scripted,
  scriptedLayer,
  usageRow,
} from "../../harness/scripted.ts"
import { executePool, indexBugClaims, repairPoolOutput } from "./pool.ts"

const REVIEW_ROOT = "/fixture/review-worktree"

const target = ReviewTarget.cases.PullRequest.make({
  repoRoot: "/fixture/repo",
  number: 1,
  headCommit: "abc1234",
  baseCommit: "def5678",
  changedFiles: ["alpha.txt"],
  diff: "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1,2 @@\n first line\n+added-line\n",
  warnings: [],
})

const claim = (id: string) =>
  Candidate.cases.BugClaim.make({
    id,
    lens: "fixture",
    file: `${id}.ts`,
    summary: `summary ${id}`,
    failureScenario: `failure ${id}`,
  })

const bugClaims = [claim("one"), claim("two"), claim("three"), claim("four")]

const runPool = (scripted: Scripted, seatless = false) =>
  Effect.gen(function* () {
    const plan: ReviewPlan = {
      runId: "pool-test-run",
      target,
      seats: seatless ? {} : { pool: "openai-codex/gpt-5.6-luna:low" },
      lenses: [],
    }
    return yield* executePool({
      plan,
      reviewWorkingDirectory: REVIEW_ROOT,
      bugClaims,
    })
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, scriptedLayer(scripted)),
    ),
  )

describe("Pool stage interface", () => {
  it.effect("pays one text-only invocation against the shipped template and repairs its clusters", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [{
          prompts: [{
            events: [
              { afterMillis: 0, kind: "message_start" },
              {
                afterMillis: 0,
                kind: "emit",
                valid: true,
                args: {
                  clusters: [
                    { indexes: [1, 3], summary: "one and three are one defect" },
                    { indexes: [2, 9], summary: "two, with an unknown index" },
                  ],
                },
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
        }],
      })

      const result = yield* runPool(scripted)

      expect(result.clusters).toEqual([
        { number: 1, indexes: [1, 3], summary: "one and three are one defect" },
        { number: 2, indexes: [2], summary: "summary two" },
        { number: 3, indexes: [4], summary: "summary four" },
      ])
      expect(result.coverageGaps).toEqual([
        {
          stage: "pool",
          reason:
            "pool output required repair: ignored unknown indexes 9; restored singleton indexes 4",
        },
      ])
      expect(result.costUsd).toBe(0.05)
      expect(result.invocationCount).toBe(1)

      expect(scripted.configs).toHaveLength(1)
      expect(scripted.configs[0]?.seat).toBe("openai-codex/gpt-5.6-luna:low")
      expect(scripted.configs[0]?.tools).toEqual([])
      expect(scripted.configs[0]?.emitTool.name).toBe("emit_pool")

      // The real shipped template, asserted structurally: its one slot filled
      // with every BugClaim's candidate line — never wording.
      const [prompt = ""] = scripted.prompts.map(({ text }) => text)
      expect(prompt).not.toContain("{{")
      expect(prompt).toContain("## Candidates")
      expect(prompt).toContain(
        "[1] (fixture) one.ts — summary one\n    claimed failure: failure one",
      )
      expect(prompt).toContain("[4] (fixture) four.ts — summary four")
      // Text-only: no scope block, no diff.
      expect(prompt).not.toContain("added-line")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps every claim as its own cluster with a coverage gap when the plan froze no pool seat", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({ sessions: [] })

      const result = yield* runPool(scripted, true)

      expect(result.clusters.map(({ indexes, number }) => [number, indexes])).toEqual([
        [1, [1]],
        [2, [2]],
        [3, [3]],
        [4, [4]],
      ])
      expect(result.coverageGaps).toEqual([
        {
          stage: "pool",
          reason:
            "pool has no seat frozen in the review plan; used singleton clusters",
        },
      ])
      expect(result.costUsd).toBe(0)
      expect(result.invocationCount).toBe(0)
      expect(scripted.configs).toHaveLength(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("Pool repair", () => {
  const claims = indexBugClaims([...bugClaims, claim("five")])

  it("uses singleton clusters when Pool has no decodable output", () => {
    const repaired = repairPoolOutput(claims, undefined)

    expect(repaired.clusters).toEqual([
      { indexes: [1], summary: "summary one" },
      { indexes: [2], summary: "summary two" },
      { indexes: [3], summary: "summary three" },
      { indexes: [4], summary: "summary four" },
      { indexes: [5], summary: "summary five" },
    ])
    expect(repaired.notes).toEqual(["restored singleton indexes 1, 2, 3, 4, 5"])
  })

  it("keeps the first valid placement and restores uncovered claims", () => {
    const repaired = repairPoolOutput(claims, {
      clusters: [
        { indexes: [2, 99, 1], summary: "merged one and two" },
        { indexes: [2, 3], summary: "duplicate two" },
        { indexes: [99], summary: "unknown only" },
        { indexes: [5], summary: "five" },
      ],
    })

    expect(repaired.clusters).toEqual([
      { indexes: [2, 1], summary: "summary two" },
      { indexes: [3], summary: "summary three" },
      { indexes: [5], summary: "five" },
      { indexes: [4], summary: "summary four" },
    ])
    expect(repaired.notes).toEqual([
      "ignored unknown indexes 99, 99",
      "ignored duplicate indexes 2",
      "restored singleton indexes 4",
    ])
  })
})
