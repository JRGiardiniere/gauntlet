import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { Candidate } from "../../domain/candidate.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import { ReviewSpecification } from "../../domain/review-specification.ts"
import { ReviewTarget } from "../../domain/review-target.ts"
import {
  makeScripted,
  type Scripted,
  scriptedLayer,
  type ScriptedSession,
  usageRow,
} from "../../harness/scripted.ts"
import { REVIEW_WORKSPACE_ROOT } from "../../workspace/review-workspace.ts"
import { indexBugClaims } from "../pool/pool.ts"
import type { VerdictsOutput } from "./output-contract.ts"
import { executeVerification } from "./verification.ts"

const REVIEW_ROOT = "/fixture/review-worktree"
const SPECIFICATION_NEEDLE = "SPECIFICATION-NEEDLE: alpha.txt must stay sorted"

const target = ReviewTarget.cases.PullRequest.make({
  repoRoot: "/fixture/repo",
  number: 1,
  headCommit: "abc1234",
  baseCommit: "def5678",
  changedFiles: ["alpha.txt"],
  diff: "--- a/alpha.txt\n+++ b/alpha.txt\n@@ -1 +1,2 @@\n first line\n+added-line\n",
  warnings: [],
})

const claims = indexBugClaims(
  ["one", "two", "three", "four", "five", "six"].map((id) =>
    Candidate.cases.BugClaim.make({
      id,
      lens: "fixture",
      file: `${id}.ts`,
      summary: `summary ${id}`,
      failureScenario: `failure ${id}`,
    })),
)

// Five clusters, the first holding two claims: two verifier bundles.
const pooled = {
  claims,
  clusters: [
    { number: 1, indexes: [1, 2], summary: "one and two are one defect" },
    { number: 2, indexes: [3], summary: "summary three" },
    { number: 3, indexes: [4], summary: "summary four" },
    { number: 4, indexes: [5], summary: "summary five" },
    { number: 5, indexes: [6], summary: "summary six" },
  ],
}

const verdictSession = (
  forSession: string,
  verdicts: VerdictsOutput["verdicts"],
): ScriptedSession => ({
  forSession,
  prompts: [{
    events: [
      { afterMillis: 0, kind: "message_start" },
      { afterMillis: 0, kind: "emit", valid: true, args: { verdicts } },
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

const runVerification = (scripted: Scripted, seatless = false) =>
  Effect.gen(function* () {
    const plan: ReviewPlan = {
      runId: "verification-test-run",
      target,
      seats: seatless
        ? {}
        : { verification: "openai-codex/gpt-5.6-luna:low" },
      lenses: [],
      specification: ReviewSpecification.make({
        documents: [{
          role: "caller-addendum",
          provenance: "/fixture/addendum.md",
          text: SPECIFICATION_NEEDLE,
        }],
        comments: [],
      }),
    }
    return yield* executeVerification({
      plan,
      reviewWorkingDirectory: REVIEW_ROOT,
      pooled,
    })
  }).pipe(
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, scriptedLayer(scripted)),
    ),
  )

describe("Verification stage interface", () => {
  it.effect("pays one invocation per bundle of four clusters against the shipped templates", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({
        sessions: [
          verdictSession("-verification-1", [
            {
              cluster: 1,
              verdict: "CONFIRMED",
              review_priority: "P1",
              evidence: "reproduced on empty input",
            },
            { cluster: 2, verdict: "REFUTED", evidence: "the guard rejects it" },
            {
              cluster: 3,
              verdict: "PLAUSIBLE",
              review_priority: "P2",
              evidence: "needs runtime state",
            },
            {
              cluster: 4,
              verdict: "CONFIRMED",
              review_priority: "P3",
              evidence: "the duplicate is real",
              test_suggestion: {
                tests: ["the five suite"],
                reason: "it covers the duplicated branch",
              },
            },
          ]),
          verdictSession("-verification-2", [
            { cluster: 5, verdict: "REFUTED", evidence: "already guarded" },
          ]),
        ],
      })

      const result = yield* runVerification(scripted)

      expect(
        result.bugClaims.map(({ cluster, verdict }) => [cluster, verdict._tag]),
      ).toEqual([
        [1, "Confirmed"],
        [1, "Confirmed"],
        [2, "Refuted"],
        [3, "Plausible"],
        [4, "Confirmed"],
        [5, "Refuted"],
      ])
      expect(result.testSuggestions).toEqual([{
        tests: ["the five suite"],
        reason: "it covers the duplicated branch",
        bugClaimIds: ["five"],
      }])
      expect(result.coverageGaps).toEqual([])
      expect(result.costUsd).toBe(0.1)
      expect(result.invocationCount).toBe(2)

      expect(scripted.configs).toHaveLength(2)
      for (const config of scripted.configs) {
        expect(config.cwd).toBe(REVIEW_ROOT)
        expect(config.tools).toEqual(["read", "bash"])
        expect(config.emitTool.name).toBe("emit_verdicts")
      }

      // The real shipped templates, asserted structurally: every placeholder
      // resolved, the scope block, then the specification, then the bundle's
      // own [cN] clusters — never wording.
      const promptFor = (bundle: string) =>
        scripted.prompts.find(({ invocationId }) =>
          invocationId.endsWith(`-verification-${bundle}`)
        )?.text ?? ""
      const first = promptFor("1")
      expect(first).not.toContain("{{")
      expect(first).toContain(`Repo root: ${REVIEW_WORKSPACE_ROOT}`)
      expect(first).not.toContain(REVIEW_ROOT)
      expect(first.indexOf(SPECIFICATION_NEEDLE)).toBeGreaterThan(
        first.indexOf("+added-line"),
      )
      expect(first.indexOf(SPECIFICATION_NEEDLE)).toBeLessThan(
        first.indexOf("### [c1]"),
      )
      expect(first).toContain(
        "### [c1] one and two are one defect\n  [1] (fixture) one.ts — summary one\n      claimed failure: failure one\n  [2] (fixture) two.ts — summary two",
      )
      expect(first).toContain("### [c4] summary five")
      expect(first).not.toContain("[c5]")
      const second = promptFor("2")
      expect(second).toContain("### [c5] summary six")
      expect(second).not.toContain("[c1]")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("retains every claim as plausible with a coverage gap when the plan froze no verification seat", () =>
    Effect.gen(function* () {
      const scripted = makeScripted({ sessions: [] })

      const result = yield* runVerification(scripted, true)

      expect(
        result.bugClaims.map(({ verdict }) => verdict._tag),
      ).toEqual(globalThis.Array.from({ length: 6 }, () => "Plausible"))
      expect(result.coverageGaps).toEqual([
        {
          stage: "verification",
          reason:
            "verification has no seat frozen in the review plan; retained every claim as plausible without examination",
        },
      ])
      expect(result.costUsd).toBe(0)
      expect(result.invocationCount).toBe(0)
      expect(scripted.configs).toHaveLength(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
