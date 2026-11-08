import * as Array from "effect/Array"
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
    Array.map(results, ({ lens, outcome }) => [lens.name, outcome] as const),
  )
  const eligible = Array.flatMap(finderPartitionsInPlan(plan), (partition) =>
    Array.flatMap(partition.slice(1), ({ lens }) => {
      const usage = firstEligibleUsage(outcomeByLens.get(lens.name))
      return usage === undefined ? [] : [usage]
    }))
  if (eligible.length < 2) return undefined
  const totalPromptTokens = Array.reduce(eligible, 0, (total, usage) => total + usage.promptTokens)
  const totalCacheRead = Array.reduce(eligible, 0, (total, usage) => total + usage.cacheRead)
  const reuse = totalCacheRead / totalPromptTokens
  if (reuse >= 0.5) return undefined
  return {
    reuse,
    eligibleFollowerCount: eligible.length,
    healthyFollowerCount: Array.filter(
      eligible,
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
