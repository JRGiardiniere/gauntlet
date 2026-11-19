// ChatGPT sign-in through the embedded Host's integration APIs, into
// Gauntlet's own store: the person's OpenCode, Codex and Pi logins are never
// read, copied or rotated. An OpenAI API key needs no login: OpenCode reads
// OPENAI_API_KEY from the environment. Claude uses the installed `claude`.
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Schedule from "effect/Schedule"
import * as Schema from "effect/Schema"
import * as Terminal from "effect/Terminal"
import * as Command from "effect/cli/Command"
import { type ConnectionState, Host, type PasteResult, type SignInStatus } from "../host/host.ts"
import { progress } from "./progress.ts"

export class LoginError extends Schema.TaggedError<
  LoginError,
  { readonly brand: unique symbol }
>()("LoginError", {
  reason: Schema.String,
}) {}

// OpenCode's own sign-in loop checks the attempt every half second; the
// attempt lives in this process's Host, so a check is an in-memory read.
const STATUS_INTERVAL = "500 millis"

const awaitSettled = Effect.fn("Login.awaitSettled")(function* (attemptID: string) {
  const host = yield* Host
  return yield* host.chatGptSignIn.status(attemptID).pipe(
    Effect.repeat({
      schedule: Schedule.spaced(STATUS_INTERVAL),
      until: (status: SignInStatus) => status._tag !== "Pending",
    }),
  )
})

// The browser's redirect reaches a callback on this Machine's loopback, so a
// browser elsewhere (Tailscale, SSH) cannot deliver it: pasting the URL it
// was redirected to hands the code over instead. A rejected or failed paste
// asks again while the attempt is still pending; once it has settled, the
// status wait reports how. A Host that cannot report the attempt is broken,
// and fails the login.
const pasteRedirect = Effect.fn("Login.pasteRedirect")(function* (attemptID: string) {
  const host = yield* Host
  const terminal = yield* Terminal.Terminal
  while (true) {
    yield* progress("if the browser can't reach this machine, paste the URL it was redirected to:")
    const pasted = (yield* terminal.readLine).trim()
    if (pasted === "") continue
    const result = yield* host.chatGptSignIn.paste(attemptID, pasted).pipe(
      Effect.catchTag("HostError", (failure) =>
        host.chatGptSignIn.status(attemptID).pipe(
          Effect.mapBoth({
            onFailure: () => failure,
            onSuccess: (status): PasteResult =>
              status._tag === "Pending" ? { _tag: "Rejected", reason: failure.reason } : { _tag: "Accepted" },
          }),
        )),
    )
    if (result._tag === "Accepted") return
    yield* progress(`that URL was not accepted — ${result.reason}`)
  }
})

const describeClaude = (state: ConnectionState): string => {
  switch (state._tag) {
    case "Connected":
      return "Claude Seats use the installed `claude` login"
    case "NeedsAuth":
      return `Claude Seats need \`claude\`: ${state.message}`
    case "NotConnected":
      return "Claude Seats are not connected"
  }
}

const executeLogin = Effect.fn("Login.run")(function* () {
  const host = yield* Host
  const attempt = yield* host.chatGptSignIn.start
  yield* Effect.addFinalizer(() => host.chatGptSignIn.cancel(attempt.attemptID))
  yield* progress(attempt.instructions)
  yield* progress(attempt.url)
  const settled = attempt.paste
    ? yield* Effect.raceFirst(
      awaitSettled(attempt.attemptID),
      pasteRedirect(attempt.attemptID).pipe(Effect.andThen(Effect.never)),
    )
    : yield* awaitSettled(attempt.attemptID)
  switch (settled._tag) {
    case "Failed":
      return yield* LoginError.make({ reason: settled.message })
    case "Expired":
    case "Pending":
      return yield* LoginError.make({ reason: "the sign-in expired — run `gauntlet login` again" })
    case "Complete":
      break
  }
  yield* Console.log("signed in to ChatGPT")
  // Sign-in has succeeded; a Claude status that can't be read is only reported.
  const claude = yield* host.connection("claude-agent").pipe(
    Effect.map(describeClaude),
    Effect.catchTag("HostError", (failure) => Effect.succeed(`Claude status unavailable — ${failure.reason}`)),
  )
  yield* Console.log(claude)
}, Effect.scoped)

export const loginCommand = Command.make(
  "login",
  {},
  () =>
    executeLogin().pipe(
      Effect.catchTags({
        HostError: (failure) => LoginError.make({ reason: failure.reason }),
        QuitError: () => LoginError.make({ reason: "sign-in cancelled" }),
      }),
    ),
).pipe(
  Command.withDescription(
    "Sign in with ChatGPT into Gauntlet's own store (an OpenAI API key needs no login: set OPENAI_API_KEY)",
  ),
)
