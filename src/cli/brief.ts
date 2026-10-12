import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Run from "../run/run.ts"

// The instructions for writing one finding's brief, on stdout for the agent
// that will write it.
export const briefCommand = Command.make(
  "brief",
  {
    runId: Argument.String("run-id").pipe(
      Argument.withDescription("Completed run the finding belongs to"),
    ),
    findingId: Argument.String("finding-id").pipe(
      Argument.withDescription("The finding's id, such as subjective/6"),
    ),
  },
  Effect.fn("Cli.brief")(function* ({ runId, findingId }) {
    yield* Console.log(yield* Run.brief(runId, findingId))
  }),
).pipe(
  Command.withDescription(
    "Print the instructions for an agent to write a brief for one finding of a run",
  ),
)
