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
  durationMillis: 1,
  diagnostics: [],
})

describe("resolveVerification", () => {
  it("maps CONFIRMED, UNVERIFIED, and REFUTED onto domain verdicts", () => {
    const claims = indexBugClaims([claim("one"), claim("two"), claim("three")])
    const clusters = numberPoolClusters(singletonClusters(claims))
    const resolved = resolveVerification(claims, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "CONFIRMED",
            severity: "P1",
            evidence: "reproduced on empty input",
          },
          {
            cluster: 2,
            verdict: "UNVERIFIED",
            severity: "P2",
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
        severity: "P1",
        evidence: "reproduced on empty input",
      }),
      Verdict.cases.Unverified.make({
        severity: "P2",
        evidence: "needs runtime state",
      }),
      Verdict.cases.Refuted.make({
        evidence: "the guard rejects the input",
      }),
    ])
    expect(resolved.coverageGaps).toEqual([])
  })

  it("treats Unverified as a first-class verdict, not an absence", () => {
    const claims = indexBugClaims([claim("one")])
    const clusters = numberPoolClusters(singletonClusters(claims))
    const resolved = resolveVerification(claims, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "UNVERIFIED",
            severity: "P3",
            evidence: "could not reach the trigger",
          },
        ]),
      },
    ])

    expect(resolved.bugClaims[0]?.verdict._tag).toBe("Unverified")
    expect(resolved.bugClaims[0]?.verdict).toEqual(
      Verdict.cases.Unverified.make({
        severity: "P3",
        evidence: "could not reach the trigger",
      }),
    )
  })

  it("fails a whole bundle closed when its verdict set is incomplete", () => {
    const claims = indexBugClaims([claim("one"), claim("two")])
    const clusters = numberPoolClusters(singletonClusters(claims))
    const resolved = resolveVerification(claims, [
      {
        bundleNumber: 1,
        clusters,
        outcome: completed([
          {
            cluster: 1,
            verdict: "CONFIRMED",
            severity: "P1",
            evidence: "only one cluster was returned",
          },
        ]),
      },
    ])

    expect(resolved.bugClaims.map(({ verdict }) => verdict._tag)).toEqual([
      "Unverified",
      "Unverified",
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
