import { createInterface } from "node:readline/promises"
import type { AuthEvent, AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai"
import { getAgentDir, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

export class LoginError extends Data.TaggedError("LoginError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

const describeEvent = (event: AuthEvent): string => {
  switch (event.type) {
    case "auth_url":
      return `${event.instructions ?? "Sign in in your browser:"}\n  ${event.url}`
    case "device_code":
      return `Enter code ${event.userCode} at ${event.verificationUri}`
    case "info":
    case "progress":
      return event.message
  }
}

// Pi's provider login flows driven from the terminal: events print to stderr,
// prompts read a line from stdin. A `manual_code` prompt races Pi's localhost
// callback server, which aborts the prompt's signal when the browser wins.
const terminalInteraction = (signal: AbortSignal): AuthInteraction & { readonly close: () => void } => {
  const terminal = createInterface({ input: process.stdin, output: process.stderr })
  const cancel = new AbortController()
  terminal.on("SIGINT", () => cancel.abort())
  const loginSignal = AbortSignal.any([signal, cancel.signal])
  const ask = (message: string, prompt: AuthPrompt) =>
    terminal.question(`${message} `, {
      signal: prompt.signal === undefined ? loginSignal : AbortSignal.any([prompt.signal, loginSignal]),
    })
  return {
    signal: loginSignal,
    notify: (event) => {
      process.stderr.write(`${describeEvent(event)}\n`)
    },
    prompt: (prompt) => {
      if (prompt.type !== "select") return ask(prompt.message, prompt).then((answer) => answer.trim())
      const listing = prompt.options
        .map((option, index) => `  ${String(index + 1)}. ${option.label}`)
        .join("\n")
      return ask(`${prompt.message}\n${listing}\n>`, prompt).then((answer) =>
        prompt.options[Number(answer.trim()) - 1]?.id ?? answer.trim()
      )
    },
    close: () => terminal.close(),
  }
}

// Stores the credential in Pi's auth.json, the same store every review reads,
// through the Pi version embedded in this binary. OAuth sign-in only: an
// API-key provider reads its key from the environment instead. Pi's ChatGPT
// flow needs a stable device ID; it is Pi's own, so a standalone `pi` agrees.
export const loginProvider = Effect.fn("PiLogin.login")(function* (provider: string) {
  const failure = (cause: unknown) =>
    new LoginError({ reason: cause instanceof Error ? cause.message : String(cause), cause })
  const runtime = yield* Effect.tryPromise({
    try: (signal) => ModelRuntime.create({ signal }),
    catch: failure,
  })
  const auth = runtime.getProvider(provider)?.auth
  if (auth === undefined) {
    return yield* new LoginError({ reason: `unknown provider ${provider}` })
  }
  const oauth = auth.oauth
  if (oauth === undefined) {
    return yield* new LoginError({
      reason: `${provider} has no sign-in; an API-key provider reads its key from the environment`,
    })
  }
  const settings = SettingsManager.create(process.cwd(), getAgentDir())
  yield* Effect.tryPromise({
    try: (signal) => {
      const interaction = terminalInteraction(signal)
      return runtime
        .login(provider, "oauth", interaction, {
          getDeviceId: () => settings.getOrCreateDeviceId(),
        })
        .finally(() => {
          interaction.close()
          return settings.flush()
        })
    },
    catch: failure,
  })
  return oauth.name
})
