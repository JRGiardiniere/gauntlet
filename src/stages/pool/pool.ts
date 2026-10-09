import * as Array from "effect/Array"
import * as DateTime from "effect/DateTime"
import * as Effect from "effect/Effect"
import * as HashSet from "effect/HashSet"
import * as Option from "effect/Option"
import * as Result from "effect/Result"
import { formatCandidateLine } from "../../content/candidate-line.ts"
import { isCompiledBinary } from "../../content/lens.ts"
import {
  readPromptTemplate,
  renderPromptTemplate,
} from "../../content/prompt-template.ts"
import { describeMissingOutput } from "../../assembly/outcome.ts"
import type { BugClaim } from "../../domain/candidate.ts"
import type { CoverageGap } from "../../domain/dossier.ts"
import type { ReviewPlan } from "../../domain/review-plan.ts"
import {
  counted,
  coverageGapLine,
  runProgress,
  wallSeconds,
} from "../../run/progress-text.ts"
import { invokeStageAgent } from "../evaluation.ts"
import { EmitPool, type PoolOutput } from "./output-contract.ts"

// Under this many BugClaims, Pool is skipped and each claim is its own
// cluster (an unmeasured default, docs/spec/pipeline-shape.md).
const POOL_SKIP_UNDER = 3

// Pool reads only the candidate text: no tools, no workspace, no
// ReviewSpecification.
const POOL_TOOLS = [] as const

// Compiled, the binary embeds the template at its repo-relative path under
// the bundle root (see stages/judgment/prompt.ts).
const templatePath = isCompiledBinary
  ? `${import.meta.dirname}/src/stages/pool/pool.md`
  : `${import.meta.dirname}/pool.md`

export interface IndexedBugClaim {
  readonly index: number
  readonly candidate: BugClaim
}

export interface PoolCluster {
  readonly indexes: ReadonlyArray<number>
  readonly summary: string
}

export interface NumberedPoolCluster extends PoolCluster {
  readonly number: number
}

// Pool's clusters, numbered across the Run: Verification checks them and
// Judgment drops an Observation restating one (docs/spec/pipeline-shape.md).
export interface PooledBugClaims {
  readonly claims: ReadonlyArray<IndexedBugClaim>
  readonly clusters: ReadonlyArray<NumberedPoolCluster>
}

export interface PoolExecution {
  readonly plan: ReviewPlan
  readonly reviewWorkingDirectory: string
  readonly bugClaims: ReadonlyArray<BugClaim>
}

export interface PoolResult extends PooledBugClaims {
  readonly coverageGaps: ReadonlyArray<CoverageGap>
  readonly costUsd: number
  readonly invocationCount: number
}

export const indexBugClaims = (
  candidates: ReadonlyArray<BugClaim>,
): ReadonlyArray<IndexedBugClaim> =>
  Array.map(candidates, (candidate, index) => ({
    index: index + 1,
    candidate,
  }))

const singletonClusters = (
  claims: ReadonlyArray<IndexedBugClaim>,
): ReadonlyArray<PoolCluster> =>
  Array.map(claims, ({ candidate, index }) => ({
    indexes: [index],
    summary: candidate.summary,
  }))

const numberClusters = (
  clusters: ReadonlyArray<PoolCluster>,
): ReadonlyArray<NumberedPoolCluster> =>
  Array.map(clusters, (cluster, index) => ({ ...cluster, number: index + 1 }))

export interface PoolRepair {
  readonly clusters: ReadonlyArray<PoolCluster>
  readonly notes: ReadonlyArray<string>
}

const note = (
  label: string,
  indexes: ReadonlyArray<number>,
): ReadonlyArray<string> =>
  indexes.length === 0 ? [] : [`${label} ${indexes.join(", ")}`]

// Pool output is an execution plan, not domain truth. Preserve its first valid
// placement for each claim, discard impossible placements, then restore every
// uncovered paid claim as a singleton (docs/spec/pipeline-shape.md).
export const repairPoolOutput = (
  claims: ReadonlyArray<IndexedBugClaim>,
  output: PoolOutput | undefined,
): PoolRepair => {
  const validIndexes = HashSet.fromIterable(Array.map(claims, ({ index }) => index))
  let seen = HashSet.empty<number>()
  const unknownIndexes: Array<number> = []
  const duplicateIndexes: Array<number> = []

  const clusters = Array.filterMap(output?.clusters ?? [], (cluster) => {
    const indexes = Array.filter(cluster.indexes, (index) => {
      if (!HashSet.has(validIndexes, index)) {
        unknownIndexes.push(index)
        return false
      }
      if (HashSet.has(seen, index)) {
        duplicateIndexes.push(index)
        return false
      }
      seen = HashSet.add(seen, index)
      return true
    })
    const firstIndex = indexes[0]
    if (firstIndex === undefined) return Result.fail(undefined)
    const summary = indexes.length === cluster.indexes.length
      ? cluster.summary
      : Array.findFirst(claims, ({ index }) => index === firstIndex).pipe(
        Option.map(({ candidate }) => candidate.summary),
        Option.getOrElse(() => cluster.summary),
      )
    return Result.succeed({ indexes, summary })
  })

  const restored = Array.filter(claims, ({ index }) => !HashSet.has(seen, index))
  return {
    clusters: [...clusters, ...singletonClusters(restored)],
    notes: [
      ...note("ignored unknown indexes", unknownIndexes),
      ...note("ignored duplicate indexes", duplicateIndexes),
      ...note(
        "restored singleton indexes",
        Array.map(restored, ({ index }) => index),
      ),
    ],
  }
}

const repairReason = (notes: ReadonlyArray<string>): string | undefined =>
  notes.length === 0
    ? undefined
    : `pool output required repair: ${notes.join("; ")}`

// The Run learns Pool only through this interface. Pool clusters, never
// deletes: every claim it leaves out comes back as a singleton.
export const executePool = Effect.fn("Pool.execute")(function* ({
  bugClaims,
  plan,
  reviewWorkingDirectory,
}: PoolExecution) {
  const claims = indexBugClaims(bugClaims)
  if (claims.length < POOL_SKIP_UNDER) {
    yield* runProgress(`skipping Pool (${counted(claims.length, "BugClaim")})`)
    return {
      claims,
      clusters: numberClusters(singletonClusters(claims)),
      coverageGaps: [],
      costUsd: 0,
      invocationCount: 0,
    } satisfies PoolResult
  }

  const seat = plan.seats.pool
  if (seat === undefined) {
    const reason =
      "pool has no seat frozen in the review plan; used singleton clusters"
    yield* runProgress(coverageGapLine({ reason }))
    return {
      claims,
      clusters: numberClusters(singletonClusters(claims)),
      coverageGaps: [{ stage: "pool", reason }],
      costUsd: 0,
      invocationCount: 0,
    } satisfies PoolResult
  }

  const poolStartedAt = yield* DateTime.now
  const prompt = yield* renderPromptTemplate(
    "pool",
    yield* readPromptTemplate(templatePath),
    [["CANDIDATES", Array.map(claims, formatCandidateLine).join("\n")]],
  )
  const outcome = yield* invokeStageAgent({
    label: "Pool",
    invocationId: `${plan.runId}-pool`,
    seat,
    cwd: reviewWorkingDirectory,
    prompt,
    contract: EmitPool,
    tools: POOL_TOOLS,
  })

  const repair = repairPoolOutput(claims, outcome.output)
  const reason = outcome.output === undefined
    ? describeMissingOutput("pool", outcome)
    : repairReason(repair.notes)
  if (reason !== undefined) {
    yield* runProgress(coverageGapLine({ reason }))
  }
  yield* runProgress(
    `Pool finished — ${String(yield* wallSeconds(poolStartedAt))}s`,
  )
  return {
    claims,
    clusters: numberClusters(repair.clusters),
    coverageGaps: reason === undefined ? [] : [{ stage: "pool", reason }],
    costUsd: outcome.usage.costUsd,
    invocationCount: 1,
  } satisfies PoolResult
})
