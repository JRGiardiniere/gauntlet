import * as Effect from "effect/Effect"
import * as Stdio from "effect/Stdio"
import * as Stream from "effect/Stream"

// The two process-output channels, written through the Stdio service so tests
// capture them. stdout is the product surface (digest, gate report); stderr
// is progress narration only (ADR 0005).

export const writeStdout = Effect.fn("gauntlet.cli.write_stdout")(
  function* (text: string) {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(
      Stream.succeed(text),
      stdio.stdout({ endOnDone: false }),
    )
  },
)

export const progress = Effect.fn("gauntlet.cli.progress")(
  function* (text: string) {
    const stdio = yield* Stdio.Stdio
    yield* Stream.run(
      Stream.succeed(`gauntlet: ${text}\n`),
      stdio.stderr({ endOnDone: false }),
    )
  },
)
