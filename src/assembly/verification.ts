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
  readonly testSuggestions: Dossier["testSuggestions"]
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

// The wire schema keeps the optional suggestion content-loose so a bad
// suggestion can never fail-close a bundle's verdicts. Validation happens
// here: an invalid suggestion is dropped with a diagnostic while every
// verdict stands.
const validTestSuggestion = (
  result: VerificationResult,
  reported: ReportedVerdict,
): Result.Result<
  Option.Option<{ tests: Array.NonEmptyArray<string>; reason: string }>,
  string
> => {
  const suggestion = reported.test_suggestion
  if (suggestion === undefined) return Result.succeed(Option.none())
  const where =
    `verification bundle ${String(result.bundleNumber)} cluster ${String(reported.cluster)}`
  if (reported.verdict === "REFUTED") {
    return Result.fail(
      `${where} attached a test suggestion to a refuted cluster; dropped it`,
    )
  }
  const tests = (suggestion.tests ?? [])
    .map((test) => test.replace(/\s+/g, " ").trim())
    .filter((test) => test !== "")
  const reason = (suggestion.reason ?? "").replace(/\s+/g, " ").trim()
  if (!Array.isArrayNonEmpty(tests) || reason === "") {
    return Result.fail(
      `${where} returned a test suggestion without tests or a reason; dropped it`,
    )
  }
  return Result.succeed(Option.some({ tests, reason }))
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
  clusters: ReadonlyArray<NumberedPoolCluster>,
  results: ReadonlyArray<VerificationResult>,
): ResolvedVerification => {
  let byClaim = HashMap.empty<number, Verdict>()
  // The repaired Pool output places every paid claim in exactly one cluster;
  // a claim that escaped placement stands alone under its own index.
  let clusterOfClaim = HashMap.empty<number, number>()
  for (const cluster of clusters) {
    for (const index of cluster.indexes) {
      clusterOfClaim = HashMap.set(clusterOfClaim, index, cluster.number)
    }
  }
  const idOfIndex = HashMap.fromIterable(
    Array.map(claims, ({ candidate, index }) => [index, candidate.id] as const),
  )
  const coverageGaps: Array<Dossier["coverageGaps"][number]> = []
  const testSuggestions: Array<Dossier["testSuggestions"][number]> = []

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
      // One suggestion per recommending cluster, associated with every
      // cluster-mate's stable id — never once per duplicate claim.
      const suggestion = validTestSuggestion(result, reported.value)
      if (Result.isFailure(suggestion)) {
        coverageGaps.push({ stage: "verification", reason: suggestion.failure })
      } else if (Option.isSome(suggestion.success)) {
        const bugClaimIds = Array.filterMap(cluster.indexes, (index) =>
          Result.fromOption(HashMap.get(idOfIndex, index), () => undefined))
        if (Array.isArrayNonEmpty(bugClaimIds)) {
          testSuggestions.push({ ...suggestion.success.value, bugClaimIds })
        }
      }
    }
  }

  return {
    bugClaims: Array.map(claims, ({ candidate, index }) => ({
      candidate,
      cluster: Option.getOrElse(
        HashMap.get(clusterOfClaim, index),
        () => index,
      ),
      verdict: Option.getOrElse(
        HashMap.get(byClaim, index),
        () => Verdict.cases.Unverified.make({}),
      ),
    })),
    testSuggestions,
    coverageGaps,
  }
}
