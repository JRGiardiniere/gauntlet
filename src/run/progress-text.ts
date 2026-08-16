import { stripVTControlCharacters } from "node:util"
import * as DateTime from "effect/DateTime"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import { Termination } from "../domain/agent-outcome.ts"

export const counted = (count: number, singular: string): string =>
  `${String(count)} ${count === 1 ? singular : `${singular}s`}`

const MAX_PROGRESS_DETAIL_LENGTH = 200

// External diagnostic text must remain one bounded, inert terminal line.
export const progressDetail = (text: string): string => {
  const flat = stripVTControlCharacters(text).replace(/\s+/g, " ").trim()
  return flat.length > MAX_PROGRESS_DETAIL_LENGTH
    ? `${flat.slice(0, MAX_PROGRESS_DETAIL_LENGTH - 1)}…`
    : flat
}

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
