import * as Array from "effect/Array"
import * as HashMap from "effect/HashMap"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Result from "effect/Result"
import { describeMissingOutput } from "../../assembly/outcome.ts"
import type { AgentOutcome } from "../../domain/agent-outcome.ts"
import type {
  CoverageGap,
  EvaluatedBugClaim,
  TestSuggestion,
} from "../../domain/dossier.ts"
import { Verdict } from "../../domain/verdict.ts"
import type {
  NumberedPoolCluster,
  PooledBugClaims,
} from "../pool/pool.ts"
import type { VerdictsOutput } from "./output-contract.ts"

type ReportedVerdict = VerdictsOutput["verdicts"][number]

// One verifier bundle: the clusters one invocation checked, and its outcome.
export interface VerifiedBundle {
  readonly bundleNumber: number
  readonly clusters: ReadonlyArray<NumberedPoolCluster>
  readonly outcome: AgentOutcome<VerdictsOutput>
}

export interface ResolvedVerification {
  readonly bugClaims: ReadonlyArray<EvaluatedBugClaim>
  readonly testSuggestions: ReadonlyArray<TestSuggestion>
  readonly coverageGaps: ReadonlyArray<CoverageGap>
}

// A bundle's verdicts, each beside its cluster in the bundle's order, once
// every cluster has exactly one.
const validateVerdicts = (
  bundle: VerifiedBundle,
): Result.Result<
  ReadonlyArray<readonly [NumberedPoolCluster, ReportedVerdict]>,
  string
> => {
  const output = bundle.outcome.output
  if (output === undefined) {
    return Result.fail(
      describeMissingOutput(
        `verification bundle ${String(bundle.bundleNumber)}`,
        bundle.outcome,
      ),
    )
  }
  if (output.verdicts.length !== bundle.clusters.length) {
    return Result.fail(
      `verification bundle ${String(bundle.bundleNumber)} did not report every cluster exactly once`,
    )
  }

  const clusterOf = HashMap.fromIterable(
    Array.map(bundle.clusters, (cluster) => [cluster.number, cluster] as const),
  )
  let seen = HashSet.empty<number>()
  const verified: Array<readonly [NumberedPoolCluster, ReportedVerdict]> = []
  for (const verdict of output.verdicts) {
    const cluster = HashMap.get(clusterOf, verdict.cluster)
    if (Option.isNone(cluster) || HashSet.has(seen, verdict.cluster)) {
      return Result.fail(
        `verification bundle ${String(bundle.bundleNumber)} returned an unknown or duplicate cluster label`,
      )
    }
    seen = HashSet.add(seen, verdict.cluster)
    verified.push([cluster.value, verdict])
  }
  return Result.succeed(
    Array.sortWith(verified, ([cluster]) => cluster.number, Order.Number),
  )
}

// The wire schema keeps the optional suggestion content-loose so a bad
// suggestion can never fail-close a bundle's verdicts. Validation happens
// here: an invalid suggestion is dropped with a diagnostic while every
// verdict stands.
const validTestSuggestion = (
  bundle: VerifiedBundle,
  reported: ReportedVerdict,
): Result.Result<
  Option.Option<{ tests: Array.NonEmptyArray<string>; reason: string }>,
  string
> => {
  const suggestion = reported.test_suggestion
  if (suggestion === undefined) return Result.succeed(Option.none())
  const where =
    `verification bundle ${String(bundle.bundleNumber)} cluster ${String(reported.cluster)}`
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
        reviewPriority: reported.review_priority,
        evidence: reported.evidence,
      })
    case "PLAUSIBLE":
      return Verdict.cases.Plausible.make({
        reviewPriority: reported.review_priority,
        evidence: reported.evidence,
      })
    case "REFUTED":
      return Verdict.cases.Refuted.make({ evidence: reported.evidence })
  }
}

// A verifier bundle is fail-closed as one unit. A structurally valid but
// semantically incomplete verdict set therefore cannot partially relabel its
// clusters; every affected paid claim remains explicitly Plausible.
export const resolveVerification = (
  { claims, clusters }: PooledBugClaims,
  bundles: ReadonlyArray<VerifiedBundle>,
): ResolvedVerification => {
  let byClaim = HashMap.empty<number, Verdict>()
  // Pool places every claim in exactly one cluster (it restores any it left
  // out), so the own-index fallback below only answers the lookup's Option.
  let clusterOfClaim = HashMap.empty<number, number>()
  for (const cluster of clusters) {
    for (const index of cluster.indexes) {
      clusterOfClaim = HashMap.set(clusterOfClaim, index, cluster.number)
    }
  }
  const idOfIndex = HashMap.fromIterable(
    Array.map(claims, ({ candidate, index }) => [index, candidate.id] as const),
  )
  const coverageGaps: Array<CoverageGap> = []
  const testSuggestions: Array<TestSuggestion> = []

  for (const bundle of bundles) {
    const validated = validateVerdicts(bundle)
    if (Result.isFailure(validated)) {
      coverageGaps.push({
        stage: "verification",
        reason: validated.failure,
      })
      continue
    }
    for (const [cluster, reported] of validated.success) {
      const verdict = domainVerdict(reported)
      for (const index of cluster.indexes) {
        byClaim = HashMap.set(byClaim, index, verdict)
      }
      // One suggestion per recommending cluster, associated with every
      // cluster-mate's stable id — never once per duplicate claim.
      const suggestion = validTestSuggestion(bundle, reported)
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
        () => Verdict.cases.Plausible.make({}),
      ),
    })),
    testSuggestions,
    coverageGaps,
  }
}
