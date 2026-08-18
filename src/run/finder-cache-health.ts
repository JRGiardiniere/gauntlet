import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ReviewPlan } from "../domain/review-plan.ts"
import type { FinderResult } from "../assembly/finders.ts"
import { UsageRow } from "../harness/harness-session.ts"
import { finderPartitionsInPlan } from "./finder-partitions.ts"

export interface FinderCacheHealth {
  readonly reuse: number
  readonly eligibleFollowerCount: number
  readonly healthyFollowerCount: number
}

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

// Reconstruct scheduler partitions only to remove their cache-warming starters,
// then measure the eligible followers as one run-wide operational signal.
export const measureLowFinderCacheHealth = (
  plan: ReviewPlan,
  results: ReadonlyArray<FinderResult>,
): FinderCacheHealth | undefined => {
  const outcomeByLens = new Map(
    results.map(({ lens, outcome }) => [lens.name, outcome] as const),
  )
  const eligible = finderPartitionsInPlan(plan).flatMap((partition) =>
    partition.slice(1).flatMap(({ lens }) => {
      const usage = firstEligibleUsage(outcomeByLens.get(lens.name))
      return usage === undefined ? [] : [usage]
    })
  )
  if (eligible.length < 2) return undefined
  const totalPromptTokens = eligible.reduce(
    (total, usage) => total + usage.promptTokens,
    0,
  )
  const totalCacheRead = eligible.reduce(
    (total, usage) => total + usage.cacheRead,
    0,
  )
  const reuse = totalCacheRead / totalPromptTokens
  if (reuse >= 0.5) return undefined
  return {
    reuse,
    eligibleFollowerCount: eligible.length,
    healthyFollowerCount: eligible.filter(
      ({ cacheRead, promptTokens }) => cacheRead / promptTokens >= 0.8,
    ).length,
  }
}

const percentage = (reuse: number): string =>
  `${(reuse * 100).toFixed(1).replace(/\.0$/, "")}%`

export const describeFinderCacheHealth = (
  health: FinderCacheHealth,
): string =>
  `${percentage(health.reuse)} reuse across ${String(health.eligibleFollowerCount)} eligible followers; ${String(health.healthyFollowerCount)}/${String(health.eligibleFollowerCount)} at or above 80%`
