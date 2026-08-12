import * as Array from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import type { AgentOutcome } from "../domain/agent-outcome.ts"
import type { Dossier } from "../domain/dossier.ts"
import { Verdict } from "../domain/verdict.ts"
import type { VerdictsOutput } from "../harness/output-contract.ts"
import type {
  IndexedBugClaim,
  NumberedPoolCluster,
} from "./pool.ts"
import { describeMissingOutput } from "./outcome.ts"

type ReportedVerdict = VerdictsOutput["verdicts"][number]

export interface VerificationResult {
  readonly bundleNumber: number
  readonly clusters: ReadonlyArray<NumberedPoolCluster>
  readonly outcome: AgentOutcome<VerdictsOutput>
}

export interface ResolvedVerification {
  readonly bugClaims: Dossier["bugClaims"]
  readonly coverageGaps: Dossier["coverageGaps"]
}

const validateVerdicts = (
  result: VerificationResult,
): Result.Result<HashMap.HashMap<number, ReportedVerdict>, string> => {
  const output = result.outcome.output
  if (output === undefined) {
    return Result.fail(
      describeMissingOutput(
        `verification bundle ${String(result.bundleNumber)}`,
        result.outcome,
      ),
    )
  }
  if (output.verdicts.length !== result.clusters.length) {
    return Result.fail(
      `verification bundle ${String(result.bundleNumber)} did not report every cluster exactly once`,
    )
  }

  const expected = HashSet.fromIterable(
    Array.map(result.clusters, ({ number }) => number),
  )
  let seen = HashSet.empty<number>()
  let byCluster = HashMap.empty<number, ReportedVerdict>()
  for (const verdict of output.verdicts) {
    if (
      !HashSet.has(expected, verdict.cluster) ||
      HashSet.has(seen, verdict.cluster)
    ) {
      return Result.fail(
        `verification bundle ${String(result.bundleNumber)} returned an unknown or duplicate cluster label`,
      )
    }
    seen = HashSet.add(seen, verdict.cluster)
    byCluster = HashMap.set(byCluster, verdict.cluster, verdict)
  }
  return Result.succeed(byCluster)
}

const domainVerdict = (reported: ReportedVerdict): Verdict => {
  switch (reported.verdict) {
    case "CONFIRMED":
      return Verdict.cases.Confirmed.make({
        severity: reported.severity,
        evidence: reported.evidence,
      })
    case "UNVERIFIED":
      return Verdict.cases.Unverified.make({
        severity: reported.severity,
        evidence: reported.evidence,
      })
    case "REFUTED":
      return Verdict.cases.Refuted.make({ evidence: reported.evidence })
  }
}

// A verifier bundle is fail-closed as one unit. A structurally valid but
// semantically incomplete verdict set therefore cannot partially relabel its
// clusters; every affected paid claim remains explicitly Unverified.
export const resolveVerification = (
  claims: ReadonlyArray<IndexedBugClaim>,
  results: ReadonlyArray<VerificationResult>,
): ResolvedVerification => {
  let byClaim = HashMap.empty<number, Verdict>()
  const coverageGaps: Array<Dossier["coverageGaps"][number]> = []

  for (const result of results) {
    const validated = validateVerdicts(result)
    if (Result.isFailure(validated)) {
      coverageGaps.push({
        stage: "verification",
        reason: validated.failure,
      })
      continue
    }
    for (const cluster of result.clusters) {
      const reported = HashMap.get(validated.success, cluster.number)
      if (Option.isNone(reported)) continue
      const verdict = domainVerdict(reported.value)
      for (const index of cluster.indexes) {
        byClaim = HashMap.set(byClaim, index, verdict)
      }
    }
  }

  return {
    bugClaims: Array.map(claims, ({ candidate, index }) => ({
      candidate,
      verdict: Option.getOrElse(
        HashMap.get(byClaim, index),
        () => Verdict.cases.Unverified.make({}),
      ),
    })),
    coverageGaps,
  }
}
