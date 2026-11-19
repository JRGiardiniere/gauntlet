import * as Console from "effect/Console"
import * as Effect from "effect/Effect"

// The CLI's stderr lines, each prefixed `gauntlet: ` (ADR 0005).
export const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)
