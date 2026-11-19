import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Ref from "effect/Ref"
import * as Terminal from "effect/Terminal"
import * as TestClock from "effect/testing/TestClock"
import * as TestConsole from "effect/testing/TestConsole"
import { unusedGitHubLayer } from "../github/github.ts"
import { makeScripted, scriptedLayer } from "../harness/scripted.ts"
import { HostError, hostLayer, type SignInStatus } from "../host/host.ts"
import { runGauntlet } from "./main.ts"

// `gauntlet login` against a fake ChatGPT integration: the Host's sign-in
// attempt is scripted, and a fake terminal supplies what the person pastes.

const REDIRECT = "http://localhost:1455/auth/callback?code=abc&state=xyz"

interface FakeIntegration {
  readonly cancelled: Ref.Ref<ReadonlyArray<string>>
  readonly pasted: Ref.Ref<ReadonlyArray<string>>
}

const fakeHost = (
  integration: FakeIntegration,
  // The attempt's status on each check, given what has been pasted so far.
  status: (checks: number, pasted: ReadonlyArray<string>) => SignInStatus,
) =>
  Layer.unwrap(Effect.gen(function* () {
    const checks = yield* Ref.make(0)
    const untouched = Effect.die("unused")
    return hostLayer({
      listModels: untouched,
      connection: (id) =>
        id === "claude-agent"
          ? Effect.succeed({ _tag: "NeedsAuth", message: "Claude Code is not logged in." })
          : untouched,
      chatGptSignIn: {
        start: Effect.succeed({
          attemptID: "con_1",
          url: "https://auth.openai.com/oauth/authorize?fake",
          instructions: "Sign in with ChatGPT in your browser",
          paste: true,
        }),
        status: () =>
          Effect.gen(function* () {
            const count = yield* Ref.updateAndGet(checks, (n) => n + 1)
            const pasted = yield* Ref.get(integration.pasted)
            return status(count, pasted)
          }),
        paste: (_attemptID, url) =>
          url === REDIRECT
            ? Ref.update(integration.pasted, (all) => [...all, url])
            : Effect.fail(HostError.make({ operation: "complete sign-in", reason: "invalid redirect URL" })),
        cancel: (attemptID) => Ref.update(integration.cancelled, (all) => [...all, attemptID]),
      },
    })
  }))

// Lines the person types, in order; reading past them waits forever.
const fakeTerminal = (lines: ReadonlyArray<string>) =>
  Layer.effect(
    Terminal.Terminal,
    Effect.gen(function* () {
      const typed = yield* Queue.unbounded<string>()
      yield* Queue.offerAll(typed, lines)
      return Terminal.make({
        columns: Effect.succeed(80),
        rows: Effect.succeed(24),
        size: Effect.die("unused"),
        readInput: Effect.die("unused"),
        readLine: Queue.take(typed),
        display: () => Effect.void,
      })
    }),
  )

const login = (host: ReturnType<typeof fakeHost>, lines: ReadonlyArray<string>) =>
  runGauntlet(["login"]).pipe(
    Effect.provide(fakeTerminal(lines)),
    Effect.provide([
      host,
      scriptedLayer(makeScripted({ sessions: [] })),
      unusedGitHubLayer,
      ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/nonexistent-home" })),
    ]),
    Effect.provide(NodeServices.layer),
  )

const makeIntegration = Effect.gen(function* () {
  return {
    cancelled: yield* Ref.make<ReadonlyArray<string>>([]),
    pasted: yield* Ref.make<ReadonlyArray<string>>([]),
  } satisfies FakeIntegration
})

const text = (lines: ReadonlyArray<unknown>) => Array.join(Array.map(lines, String), "\n")

describe("gauntlet login", () => {
  it.effect("signs in with a pasted redirect URL, asking again after a rejected one", () =>
    Effect.gen(function* () {
      const integration = yield* makeIntegration
      const host = fakeHost(integration, (_checks, pasted) =>
        pasted.length > 0 ? { _tag: "Complete" } : { _tag: "Pending" })
      const running = yield* Effect.forkChild(login(host, ["", "http://wrong", REDIRECT]))
      yield* TestClock.adjust("2 seconds")
      const exitCode = yield* Fiber.join(running)
      expect(exitCode).toBe(0)

      const pasted = yield* Ref.get(integration.pasted)
      expect(pasted).toEqual([REDIRECT])
      const errorLines = yield* TestConsole.errorLines
      const stderr = text(errorLines)
      expect(stderr).toContain("https://auth.openai.com/oauth/authorize?fake")
      expect(stderr).toContain("paste the URL it was redirected to")
      expect(stderr).toContain("that URL was not accepted — invalid redirect URL")
      const logLines = yield* TestConsole.logLines
      const stdout = text(logLines)
      expect(stdout).toContain("signed in to ChatGPT")
      expect(stdout).toContain("Claude Seats need `claude`: Claude Code is not logged in.")
      const cancelled = yield* Ref.get(integration.cancelled)
      expect(cancelled).toEqual(["con_1"])
    }))

  it.effect("finishes when the browser completes the sign-in, with nothing pasted", () =>
    Effect.gen(function* () {
      const integration = yield* makeIntegration
      const host = fakeHost(integration, (checks) => (checks >= 3 ? { _tag: "Complete" } : { _tag: "Pending" }))
      const running = yield* Effect.forkChild(login(host, []))
      yield* TestClock.adjust("2 seconds")
      const exitCode = yield* Fiber.join(running)
      expect(exitCode).toBe(0)
      const pasted = yield* Ref.get(integration.pasted)
      expect(pasted).toEqual([])
      const logLines = yield* TestConsole.logLines
      expect(text(logLines)).toContain("signed in to ChatGPT")
    }))

  it.effect("exits 1 with the integration's reason when the sign-in fails", () =>
    Effect.gen(function* () {
      const integration = yield* makeIntegration
      const host = fakeHost(integration, () => ({ _tag: "Failed", message: "token exchange failed" }))
      const exitCode = yield* login(host, [])
      expect(exitCode).toBe(1)
      const errorLines = yield* TestConsole.errorLines
      expect(text(errorLines)).toContain("could not sign in — token exchange failed")
      const cancelled = yield* Ref.get(integration.cancelled)
      expect(cancelled).toEqual(["con_1"])
    }))
})
