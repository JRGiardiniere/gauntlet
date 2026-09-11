import { describe, expect, it } from "@effect/vitest"
import { Termination } from "../domain/agent-outcome.ts"
import { Candidate } from "../domain/candidate.ts"
import { Verdict } from "../domain/verdict.ts"
import { indexBugClaims, singletonClusters, numberPoolClusters } from "./pool.ts"
import {
  type VerificationResult,
  resolveVerification,
} from "./verification.ts"

const claim = (id: string) =>
  Candidate.cases.BugClaim.make({
    id,
    lens: "fixture-lens",
    file: `${id}.ts`,
    summary: `summary ${id}`,
    failureScenario: `failure ${id}`,
  })

const emptyUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  reasoning: 0,
  costUsd: 0,
  rawRows: [],
}

const completed = (
  verdicts: NonNullable<VerificationResult["outcome"]["output"]>["verdicts"],
): VerificationResult["outcome"] => ({
  termination: Termination.cases.Completed.make({}),
  output: { verdicts },
  usage: emptyUsage,
  toolCalls: { total: 0, errored: 0 },
  durationMillis: 1,
  diagnostics: [],
})

describe("resolveVerification", () => {
  it("maps CONFIRMED, PLAUSIBLE, and REFUTED onto domain verdicts", () => {
    const claims = indexBugClaims([claim("one"), claim("two"), claim("three")])
    const clusters = numberPoolClusters(singletonClusters(claims))
    const resolved = resolveVerification(claims, clusters, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "CONFIRMED",
            review_priority: "P1",
            evidence: "reproduced on empty input",
          },
          {
            cluster: 2,
            verdict: "PLAUSIBLE",
            review_priority: "P2",
            evidence: "needs runtime state",
          },
          {
            cluster: 3,
            verdict: "REFUTED",
            evidence: "the guard rejects the input",
          },
        ]),
      },
    ])

    expect(resolved.bugClaims.map(({ verdict }) => verdict)).toEqual([
      Verdict.cases.Confirmed.make({
        reviewPriority: "P1",
        evidence: "reproduced on empty input",
      }),
      Verdict.cases.Plausible.make({
        reviewPriority: "P2",
        evidence: "needs runtime state",
      }),
      Verdict.cases.Refuted.make({
        evidence: "the guard rejects the input",
      }),
    ])
    expect(resolved.coverageGaps).toEqual([])
  })

  it("carries the Pool cluster onto every one of its claims", () => {
    const claims = indexBugClaims([claim("one"), claim("two"), claim("three")])
    const clusters = numberPoolClusters([
      { indexes: [1, 3], summary: "one bug, two lenses" },
      { indexes: [2], summary: "summary two" },
    ])
    const resolved = resolveVerification(claims, clusters, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "CONFIRMED",
            review_priority: "P1",
            evidence: "reproduced on empty input",
          },
          {
            cluster: 2,
            verdict: "REFUTED",
            evidence: "the guard rejects the input",
          },
        ]),
      },
    ])

    expect(resolved.bugClaims.map(({ cluster }) => cluster)).toEqual([1, 2, 1])
    expect(resolved.bugClaims.map(({ verdict }) => verdict._tag)).toEqual([
      "Confirmed",
      "Refuted",
      "Confirmed",
    ])
  })

  it("maps one cluster-level test suggestion to every mate's stable id exactly once", () => {
    const claims = indexBugClaims([claim("one"), claim("two"), claim("three")])
    const clusters = numberPoolClusters([
      { indexes: [1, 3], summary: "one bug, two lenses" },
      { indexes: [2], summary: "summary two" },
    ])
    const resolved = resolveVerification(claims, clusters, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "CONFIRMED",
            review_priority: "P1",
            evidence: "reproduced on empty input",
            test_suggestion: {
              tests: [" src/one.test.ts\n", "the empty-input suite"],
              reason: "covers the\nempty-input boundary ",
            },
          },
          {
            cluster: 2,
            verdict: "PLAUSIBLE",
            review_priority: "P2",
            evidence: "needs runtime state",
            test_suggestion: {
              tests: ["src/two.test.ts"],
              reason: "exercises the runtime state",
            },
          },
        ]),
      },
    ])

    expect(resolved.testSuggestions).toEqual([
      {
        tests: ["src/one.test.ts", "the empty-input suite"],
        reason: "covers the empty-input boundary",
        bugClaimIds: ["one", "three"],
      },
      {
        tests: ["src/two.test.ts"],
        reason: "exercises the runtime state",
        bugClaimIds: ["two"],
      },
    ])
    expect(resolved.coverageGaps).toEqual([])
  })

  it("drops empty suggestions and advice for refuted claims while every verdict stands", () => {
    const claims = indexBugClaims([claim("one"), claim("two"), claim("three")])
    const clusters = numberPoolClusters(singletonClusters(claims))
    const resolved = resolveVerification(claims, clusters, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "CONFIRMED",
            review_priority: "P1",
            evidence: "reproduced on empty input",
            test_suggestion: { tests: ["  ", ""] },
          },
          {
            cluster: 2,
            verdict: "PLAUSIBLE",
            review_priority: "P2",
            evidence: "needs runtime state",
            test_suggestion: { tests: ["src/two.test.ts"], reason: " " },
          },
          {
            cluster: 3,
            verdict: "REFUTED",
            evidence: "the guard rejects the input",
            test_suggestion: {
              tests: ["src/three.test.ts"],
              reason: "would show the guard",
            },
          },
        ]),
      },
    ])

    expect(resolved.bugClaims.map(({ verdict }) => verdict._tag)).toEqual([
      "Confirmed",
      "Plausible",
      "Refuted",
    ])
    expect(resolved.testSuggestions).toEqual([])
    expect(resolved.coverageGaps.map(({ reason }) => reason)).toEqual([
      "verification bundle 1 cluster 1 returned a test suggestion without tests or a reason; dropped it",
      "verification bundle 1 cluster 2 returned a test suggestion without tests or a reason; dropped it",
      "verification bundle 1 cluster 3 attached a test suggestion to a refuted cluster; dropped it",
    ])
  })

  it("fails a whole bundle closed when its verdict set is incomplete", () => {
    const claims = indexBugClaims([claim("one"), claim("two")])
    const clusters = numberPoolClusters(singletonClusters(claims))
    const resolved = resolveVerification(claims, clusters, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "CONFIRMED",
            review_priority: "P1",
            evidence: "only one cluster was returned",
          },
        ]),
      },
    ])

    expect(resolved.bugClaims.map(({ verdict }) => verdict._tag)).toEqual([
      "Plausible",
      "Plausible",
    ])
    expect(resolved.coverageGaps).toEqual([
      {
        stage: "verification",
        reason:
          "verification bundle 1 did not report every cluster exactly once",
      },
    ])
  })
})
