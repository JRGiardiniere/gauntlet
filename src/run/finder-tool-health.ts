import type { FinderResult } from "../assembly/finders.ts"

// One run-wide count of finder inspection tool calls. A handful of errored
// calls is normal model behaviour (bad paths, unsupported flags); a cascade is
// the tool itself being dead, which findings alone never reveal.
export interface FinderToolHealth {
  readonly calls: number
  readonly errored: number
  readonly finderCount: number
  // Finders that made at least one call and had every call error.
  readonly deadFinderCount: number
}

export const measureFinderToolHealth = (
  results: ReadonlyArray<FinderResult>,
): FinderToolHealth | undefined => {
  const active = results.filter(({ outcome }) => outcome.toolCalls.total > 0)
  if (active.length === 0) return undefined
  return {
    calls: active.reduce((sum, { outcome }) => sum + outcome.toolCalls.total, 0),
    errored: active.reduce(
      (sum, { outcome }) => sum + outcome.toolCalls.errored,
      0,
    ),
    finderCount: active.length,
    deadFinderCount: active.filter(
      ({ outcome }) => outcome.toolCalls.errored === outcome.toolCalls.total,
    ).length,
  }
}

// The digest carries the tool line only for a cascade: at least half of a
// non-trivial number of calls errored. Below that the dossier still records
// the counts, but nobody should chase one or two bad calls from stdout.
export const isFinderToolCascade = (health: FinderToolHealth): boolean =>
  health.calls >= 4 && health.errored / health.calls >= 0.5

export const describeFinderToolHealth = (health: FinderToolHealth): string =>
  `${String(health.errored)}/${String(health.calls)} finder tool calls errored; ${String(health.deadFinderCount)}/${String(health.finderCount)} finders had every call error`
