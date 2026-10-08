import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Command from "effect/cli/Command"
import * as CliError from "effect/cli/CliError"
import * as Run from "../run/run.ts"
import {
  type Destination,
  reviewSyntax,
  type ReviewCommandError,
} from "../syntax/syntax.ts"

// The CLI's review and deliver: the shared syntax's commands over the Run
// module, worded as the CLI's output contract (ADR 0005) — the digest on
// stdout, `gauntlet: ` lines on stderr, and an exit code.

export const progress = Effect.fn("gauntlet.cli.progress")((text: string) =>
  Console.error(`gauntlet: ${text}`),
)

// The digest is on stdout before the post starts, so a post that hangs or
// fails never withholds it; a failed post still exits 1, as the post was asked
// for and did not happen.
const review = Effect.fn("Cli.review")(function* (
  request: Run.ReviewRequest,
  destination: Destination,
) {
  const reviewed = yield* Run.review(request)
  yield* Console.log(reviewed.digest)
  if (destination === "local") return
  const receipt = yield* Run.deliver(reviewed.runId)
  yield* progress(`posted ${receipt.url}`)
})

const deliver = Effect.fn("Cli.deliver")(function* (runId: string) {
  const receipt = yield* Run.deliver(runId)
  yield* Console.log(receipt.url)
})

const [reviewVerb, deliverVerb] = reviewSyntax({ relatedFiles: false }, {
  review,
  deliver,
})

export const reviewCommand = reviewVerb.pipe(
  Command.withDescription(
    "Review the uncommitted changes, a commit range, or a pull request. Runs for minutes and streams progress to stderr; exit 0 means a review was produced (zero findings included)",
  ),
)

export const deliverCommand = deliverVerb

// The CLI's words for a refusal: a post that may have landed names the
// command that retries it, and a missing configuration the one that sets it
// up.
const refuse = (refusal: Run.RunRefusal) =>
  progress(
    refusal.unconfirmedPost !== undefined
      ? `${refusal.reason}; check the PR for the comment before retrying with gauntlet deliver ${refusal.unconfirmedPost}`
      : refusal.unconfigured === true
      ? `${refusal.reason} — run \`gauntlet config init\``
      : refusal.reason,
  ).pipe(Effect.as(1))

// Exit codes are the CLI contract (ADR 0005): 0 = review produced (zero
// findings included), 1 = could not review or could not deliver. Findings
// never affect the exit code. Every failure is rendered to stderr before the
// Promise boundary erases its type.
export const renderReviewFailures = <R>(
  self: Effect.Effect<
    number,
    CliError.CliError | ReviewCommandError | Run.RunRefusal | Run.RunFailure,
    R
  >,
) =>
  self.pipe(
    Effect.catchTags({
      // ShowHelp is help control flow, not a failed review: the CLI has
      // already rendered help (and any parse errors). Plain help exits 0;
      // help shown because arguments failed to parse exits 1.
      ShowHelp: (help) => Effect.succeed(help.errors.length === 0 ? 0 : 1),
      ReviewCommandError: (failure) =>
        progress(`could not review — ${failure.reason}`).pipe(Effect.as(1)),
      RunRefusal: refuse,
    }),
    // The config verbs share the Run module's failures, worded as it words
    // them.
    Effect.catch((failure) =>
      CliError.isCliError(failure)
        ? progress(`could not review — ${String(failure)}`).pipe(Effect.as(1))
        : refuse(Run.refusalOf(failure))
    ),
  )
