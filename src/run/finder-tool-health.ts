import type { FinderResult } from "../assembly/finders.ts"

// One run-wide count of finder inspection tool calls. A handful of errored
// calls is normal model behaviour (bad paths, unsupported flags); a cascade is
// the tool itself being dead, which findings alone never reveal.
export interface FinderToolHealth {
  readonly calls: number
  readonly errored: number
}

export const measureFinderToolHealth = (
  results: ReadonlyArray<FinderResult>,
): FinderToolHealth | undefined => {
  const health = results.reduce<FinderToolHealth>(
    (sum, { outcome }) => ({
      calls: sum.calls + outcome.toolCalls.total,
      errored: sum.errored + outcome.toolCalls.errored,
    }),
    { calls: 0, errored: 0 },
  )
  return health.calls === 0 ? undefined : health
}

// The digest carries the tool line only for a cascade: at least half of a
// non-trivial number of calls errored. Below that the dossier still records
// the counts, but nobody should chase one or two bad calls from stdout.
export const isFinderToolCascade = (health: FinderToolHealth): boolean =>
  health.calls >= 4 && health.errored / health.calls >= 0.5

export const describeFinderToolHealth = (health: FinderToolHealth): string =>
  `${String(health.errored)}/${String(health.calls)} finder tool calls errored`
