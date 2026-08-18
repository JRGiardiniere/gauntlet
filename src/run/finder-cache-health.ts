import * as Array from "effect/Array"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ResolvedFinderContext } from "../content/finder-prompt.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import type { Seat } from "../domain/recipe.ts"
import type { FinderResult } from "../assembly/finders.ts"
import { UsageRow } from "../harness/harness-session.ts"
import { finderPartitionsInPlan } from "./finder-partitions.ts"

export type FinderContextKind =
  | "ordinary"
  | "ordinary plus frozen ReviewSpecification"

export interface FinderCacheHealth {
  readonly seat: Seat
  readonly contextKind: FinderContextKind
  readonly reuse: number
  readonly eligibleFollowerCount: number
  readonly healthyFollowerCount: number
}

const contextKindOf = (
  key: ResolvedFinderContext["key"],
): FinderContextKind =>
  key === "standard" ? "ordinary" : "ordinary plus frozen ReviewSpecification"

interface EligibleUsage {
  readonly promptTokens: number
  readonly cacheRead: number
}

const firstEligibleUsage = (
  outcome: FinderResult["outcome"] | undefined,
): EligibleUsage | undefined => {
  const raw = outcome?.usage.rawRows[0]
  if (raw === undefined) return undefined
  const decoded = Schema.decodeUnknownOption(UsageRow)(raw)
  if (Option.isNone(decoded)) return undefined
  const promptTokens = decoded.value.input + decoded.value.cacheRead
  return promptTokens === 0
    ? undefined
    : { promptTokens, cacheRead: decoded.value.cacheRead }
}

// Consume the scheduler's partitions from the frozen plan. The first planned
// Finder in each larger partition is the cache-warming starter and never
// contributes to the measurement.
export const measureFinderCacheHealth = (
  plan: ReviewPlan,
  results: ReadonlyArray<FinderResult>,
): ReadonlyArray<FinderCacheHealth> => {
  const outcomeByLens = new Map(
    results.map(({ lens, outcome }) => [lens.name, outcome] as const),
  )

  const measurements: Array<FinderCacheHealth> = []
  for (const partition of finderPartitionsInPlan(plan)) {
    if (partition.length === 1) continue
    const first = Array.headNonEmpty(partition)
    const eligible = partition
      .slice(1)
      .flatMap(({ lens }) => {
        const usage = firstEligibleUsage(outcomeByLens.get(lens.name))
        return usage === undefined ? [] : [usage]
      })
    if (eligible.length === 0) continue
    const totalPromptTokens = eligible.reduce(
      (total, usage) => total + usage.promptTokens,
      0,
    )
    const totalCacheRead = eligible.reduce(
      (total, usage) => total + usage.cacheRead,
      0,
    )
    measurements.push({
      seat: first.seat,
      contextKind: contextKindOf(first.context.key),
      reuse: totalCacheRead / totalPromptTokens,
      eligibleFollowerCount: eligible.length,
      healthyFollowerCount: eligible.filter(
        ({ cacheRead, promptTokens }) => cacheRead / promptTokens >= 0.8,
      ).length,
    })
  }
  return measurements
}

export const lowFinderCacheHealth = (
  measurements: ReadonlyArray<FinderCacheHealth>,
): ReadonlyArray<FinderCacheHealth> =>
  measurements.filter(({ eligibleFollowerCount, reuse }) =>
    eligibleFollowerCount >= 2 && reuse < 0.5
  )

const percentage = (reuse: number): string =>
  `${(reuse * 100).toFixed(1).replace(/\.0$/, "")}%`

export const describeFinderCacheHealth = (
  health: FinderCacheHealth,
): string =>
  `${health.seat} (${health.contextKind}): ${percentage(health.reuse)} reuse across ${String(health.eligibleFollowerCount)} eligible followers; ${String(health.healthyFollowerCount)}/${String(health.eligibleFollowerCount)} at or above 80%`

const bounded = (text: string, limit: number): string =>
  text.length <= limit ? text : `${text.slice(0, limit - 1)}…`

export const finderCacheHealthDigestLine = (
  measurements: ReadonlyArray<FinderCacheHealth>,
): string | undefined => {
  const low = lowFinderCacheHealth(measurements)
  return low.length === 0
    ? undefined
    : bounded(
      `cache health: ${low.map(describeFinderCacheHealth).join("; ")}`,
      240,
    )
}
