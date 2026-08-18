import type { FinderCacheHealth } from "./finder-cache-health.ts"

export interface RunAccounting {
  readonly costUsd: number
  readonly invocationCount: number
  readonly wallTimeSeconds: number
  readonly finderCacheHealth: FinderCacheHealth | undefined
}
