import * as Array from "effect/Array"
import type { AgentUsage } from "../domain/agent-outcome.ts"
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

export const sumTokens = (usages: ReadonlyArray<AgentUsage>): TokenTotals =>
  Array.reduce(usages, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, (sum, usage) => ({
    input: sum.input + usage.input,
    output: sum.output + usage.output,
    cacheRead: sum.cacheRead + usage.cacheRead,
    cacheWrite: sum.cacheWrite + usage.cacheWrite,
  }))

export interface RunAccounting {
  readonly tokens: TokenTotals
  readonly invocationCount: number
  readonly wallTimeSeconds: number
  readonly finderCacheHealth: FinderCacheHealth | undefined
  readonly finderToolHealth: FinderToolHealth | undefined
}

const thousands = (count: number): string =>
  count >= 1000 ? `${(count / 1000).toFixed(1).replace(/\.0$/, "")}k` : String(count)

// "412k in · 9.3k out · cache 96%": the cache share is of the whole prompt.
export const describeTokens = (tokens: TokenTotals): string => {
  const prompted = tokens.input + tokens.cacheRead + tokens.cacheWrite
  const cache = prompted === 0 ? "" : ` · cache ${String(Math.round((tokens.cacheRead / prompted) * 100))}%`
  return `${thousands(prompted)} in · ${thousands(tokens.output)} out${cache}`
}
