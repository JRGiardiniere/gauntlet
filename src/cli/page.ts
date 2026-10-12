import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Run from "../run/run.ts"
import { progress } from "./review.ts"

// The page's path on stdout; each brief problem on stderr, for the agent
// that wrote the brief to fix and redraw.
export const pageCommand = Command.make(
  "page",
  {
    runId: Argument.String("run-id").pipe(
      Argument.withDescription("Completed run whose page to redraw"),
    ),
  },
  Effect.fn("Cli.page")(function* ({ runId }) {
    const drawn = yield* Run.page(runId)
    for (const problem of drawn.problems) yield* progress(problem)
    yield* Console.log(drawn.path)
  }),
).pipe(
  Command.withDescription(
    "Redraw a run's dossier.html with the briefs in its briefs/ directory (briefs/<finding id>.md)",
  ),
)
