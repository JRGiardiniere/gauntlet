import * as Array from "effect/Array"
import type { FinderResult } from "../assembly/finders.ts"

// One run-wide count of finder inspection tool calls. A handful of errored
// calls is normal model behaviour (bad paths, unsupported flags); a cascade is
// the tool itself being dead, which findings alone never reveal. The paths
// behind errored calls are named whatever the ratio: one failed dependency
// read per finder is what went unchecked, not a cascade.
export interface FinderToolHealth {
  readonly calls: number
  readonly errored: number
  readonly erroredPaths: ReadonlyArray<string>
}

// How many errored paths a run note names before "+N more".
const NAMED_PATHS = 10

export const measureFinderToolHealth = (
  results: ReadonlyArray<FinderResult>,
): FinderToolHealth | undefined => {
  const health = Array.reduce(
    results,
    { calls: 0, errored: 0, erroredPaths: Array.empty<string>() },
    (sum, { outcome }) => ({
      calls: sum.calls + outcome.toolCalls.total,
      errored: sum.errored + outcome.toolCalls.errored,
      erroredPaths: [...sum.erroredPaths, ...(outcome.toolCalls.erroredPaths ?? [])],
    }),
  )

  return health.calls === 0 ? undefined : { ...health, erroredPaths: Array.dedupe(health.erroredPaths) }
}

// The digest carries the tool line only for a cascade: at least half of a
// non-trivial number of calls errored. Below that the dossier still records
// the counts, but nobody should chase one or two bad calls from stdout.
export const isFinderToolCascade = (health: FinderToolHealth): boolean =>
  health.calls >= 4 && health.errored / health.calls >= 0.5

export const describeFinderToolHealth = (health: FinderToolHealth): string =>
  `${String(health.errored)}/${String(health.calls)} finder tool calls errored`

// "on `a`, `b` (+3 more)", or undefined when no errored call named a path.
export const describeErroredPaths = (health: FinderToolHealth): string | undefined => {
  if (health.erroredPaths.length === 0) return undefined
  const named = Array.join(Array.map(health.erroredPaths.slice(0, NAMED_PATHS), (path) => `\`${path}\``), ", ")
  const more = health.erroredPaths.length - NAMED_PATHS

  return more > 0 ? `on ${named} (+${String(more)} more)` : `on ${named}`
}
