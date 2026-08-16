import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { Termination } from "../domain/agent-outcome.ts"

export const counted = (count: number, singular: string): string =>
  `${String(count)} ${count === 1 ? singular : `${singular}s`}`

export const invocationTrail = (
  durationMillis: number,
  costUsd: number,
  termination: Termination,
): string =>
  [
    `${String(Math.round(durationMillis / 1000))}s`,
    `$${costUsd.toFixed(2)}`,
    ...(Termination.guards.Completed(termination) ? [] : [termination._tag]),
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
