import * as Console from "effect/Console"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { type AgentUsage, Termination } from "../domain/agent-outcome.ts"

// A progress line of a Run's stages: on stderr, and in the Run's run.log,
// since a Run's own logs go only to that file.
export const runProgress = Effect.fn("Progress.report")(function* (text: string) {
  yield* Console.error(`gauntlet: ${text}`)
  yield* Effect.log(text)
})

// An invocation's diagnostics (a refusal, a provider's error body) go to the
// Run's run.log only: the progress line and coverage gap keep their short
// reason, and a Finder's diagnostics are already in finder-stage.json.
export const logDiagnostics = Effect.fn("Progress.logDiagnostics")(function* (
  invocation: string,
  diagnostics: ReadonlyArray<string>,
) {
  for (const diagnostic of diagnostics) {
    yield* Effect.logWarning(`${invocation} diagnostic: ${diagnostic}`)
  }
})

export const counted =(count: number, singular: string): string =>
  `${String(count)} ${count === 1 ? singular : `${singular}s`}`

// The share of prompt tokens read from the provider's cache, over one or
// many invocations; undefined when nothing was prompted.
export const cacheShare = (
  usages: ReadonlyArray<Pick<AgentUsage, "input" | "cacheRead" | "cacheWrite">>,
): string | undefined => {
  const read = usages.reduce((total, usage) => total + usage.cacheRead, 0)
  const prompted = usages.reduce(
    (total, usage) => total + usage.input + usage.cacheRead + usage.cacheWrite,
    0,
  )
  return prompted === 0
    ? undefined
    : `cache ${String(Math.round((read / prompted) * 100))}%`
}

export const invocationTrail = (outcome: {
  readonly durationMillis: number
  readonly usage: AgentUsage
  readonly termination: Termination
}): string =>
  [
    `${String(Math.round(outcome.durationMillis / 1000))}s`,
    `$${outcome.usage.costUsd.toFixed(2)}`,
    ...Option.toArray(Option.fromUndefinedOr(cacheShare([outcome.usage]))),
    ...(Termination.guards.Completed(outcome.termination)
      ? []
      : [outcome.termination._tag]),
  ].join(" · ")

export const coverageGapLine = (gap: {
  readonly reason: string
  readonly lens?: string
}): string =>
  gap.lens === undefined
    ? `coverage gap — ${gap.reason}`
    : `coverage gap (${gap.lens}) — ${gap.reason}`

export const wallSeconds = Effect.fn("gauntlet.progress_text.wall_seconds")(
  function* (startedAt: DateTime.Utc) {
    const endedAt = yield* DateTime.now
    return Math.max(
      0,
      Math.round(Duration.toSeconds(DateTime.distance(startedAt, endedAt))),
    )
  },
)
