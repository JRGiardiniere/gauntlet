// Provider sign-in through the Pi embedded in this binary, so signing in
// never needs a standalone `pi` and always matches the Pi that runs reviews.
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import { loginProvider } from "../harness/pi-login.ts"

const executeLogin = Effect.fn("Cli.login")(function* (provider: string) {
  const signedIn = yield* loginProvider(provider)
  yield* Console.log(`signed in to ${signedIn}`)
})

export const loginCommand = Command.make(
  "login",
  {
    provider: Argument.string("provider").pipe(
      Argument.withDescription("Pi provider to sign in to, e.g. openai for Sign in with ChatGPT"),
    ),
  },
  ({ provider }) => executeLogin(provider),
).pipe(
  Command.withDescription(
    "Sign in to a model provider (subscription OAuth where offered, otherwise an API key) and store it where reviews read it",
  ),
)
