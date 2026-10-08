import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Command from "effect/cli/Command"
import { configCommand } from "./config.ts"
import { loginCommand } from "./login.ts"
import {
  deliverCommand,
  progress,
  renderReviewFailures,
  reviewCommand,
} from "./review.ts"
import { availableUpdateNotice } from "./update-check.ts"
import { upgradeCommand } from "./upgrade.ts"
import { gauntletVersion } from "./version.ts"

export { ReviewCommandError } from "./review.ts"

const gauntlet = Command.make("gauntlet").pipe(
  Command.withSubcommands([
    reviewCommand,
    deliverCommand,
    configCommand,
    loginCommand,
    upgradeCommand,
  ]),
  Command.withDescription("Effect-native, Pi-harnessed code-review agent"),
)

// The daily notice is claimed after the exit code is decided: by then a
// review has given the forked probe minutes, so the extra second is only ever
// spent by fast commands on the one invocation per day that actually probes.
const reportUpdateNotice = Effect.fn("gauntlet.cli.report_update_notice")(
  function* (notice: Fiber.Fiber<Option.Option<string>>) {
    // The notice's declared error channel is `never`, so the net here is for
    // defects: an enrichment path must degrade, not crash a decided exit code.
    const available = yield* Fiber.join(notice).pipe(
      Effect.timeoutOption("1 second"),
      Effect.map(Option.flatten),
      Effect.catchCause(() => Effect.succeed(Option.none<string>())),
    )
    if (Option.isSome(available)) {
      yield* progress(
        `v${available.value} is available (current v${gauntletVersion}) — run \`gauntlet upgrade\``,
      )
    }
  },
)

// The review program's verbs and failure rendering live in review.ts; the
// config, login and upgrade verbs add only their own failures.
const runCli = (argv: ReadonlyArray<string>) =>
  Command.runWith(gauntlet, { version: gauntletVersion })(argv).pipe(
    Effect.as(0),
    Effect.catchTags({
      UpgradeError: (failure) =>
        progress(`could not upgrade — ${failure.reason}`).pipe(Effect.as(1)),
      LoginError: (failure) =>
        progress(`could not sign in — ${failure.reason}`).pipe(Effect.as(1)),
      ConfigCommandError: (failure) =>
        progress(`could not configure — ${failure.reason}`).pipe(Effect.as(1)),
    }),
    renderReviewFailures,
  )

export const runGauntlet = Effect.fn("gauntlet.cli.run")(function* (
  argv: ReadonlyArray<string>,
) {
  // upgrade does its own release lookup; a concurrent notice would probe the
  // same endpoint twice and report the pre-upgrade version right after a
  // successful upgrade.
  if (argv[0] === "upgrade") return yield* runCli(argv)
  // Forked before the command so the daily release probe overlaps the real
  // work; the notice never affects the exit code.
  const notice = yield* Effect.forkChild(availableUpdateNotice())
  const exitCode = yield* runCli(argv)
  yield* reportUpdateNotice(notice)
  return exitCode
})
