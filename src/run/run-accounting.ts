import * as Array from "effect/Array"
import type { SeatedStageName } from "../domain/stage.ts"
import type { FinderCacheHealth } from "./finder-cache-health.ts"
import type { FinderToolHealth } from "./finder-tool-health.ts"

// Tokens over a Run's invocations. `input` excludes cached tokens, so the
// whole prompt is input + cacheRead + cacheWrite.
export interface TokenTotals {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export const sumTokens = (usages: ReadonlyArray<TokenTotals>): TokenTotals =>
  Array.reduce(usages, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, (sum, usage) => ({
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: sum.cacheWrite + usage.cacheWrite,
  }))

export type StageTokens = { readonly [Stage in SeatedStageName]: TokenTotals }

export interface RunAccounting {
  readonly stageTokens: StageTokens
  readonly invocationCount: number
  readonly wallTimeSeconds: number
  readonly finderCacheHealth: FinderCacheHealth | undefined
  readonly finderToolHealth: FinderToolHealth | undefined
}

export const totalTokens = (stageTokens: StageTokens): TokenTotals =>
  sumTokens([
    stageTokens.finders,
    stageTokens.pool,
    stageTokens.verification,
    stageTokens.judgment,
  ])

const thousands = (count: number): string =>
  count >= 1_000_000
    ? `${(count / 1_000_000).toFixed(2).replace(/\.?0+$/, "")}M`
    : count >= 1000
    ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k`
    : String(count)

// "412k in (396k cache read, 96%) · 9.3k out": `in` is the whole prompt, and
// the hit rate is the share of it read from the provider's cache.
export const describeTokens = (tokens: TokenTotals): string => {
  const prompted = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const cache = prompted === 0
    ? ""
    : ` (${thousands(tokens.cacheRead)} cache read, ${String(Math.round((tokens.cacheRead / prompted) * 100))}%)`
  return `${thousands(prompted)} in${cache} · ${thousands(tokens.output)} out`
}
