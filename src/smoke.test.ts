import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"

describe("scaffold smoke", () => {
  it.effect("runs an Effect with the test clock", () =>
    Effect.gen(function* () {
      const fiber = yield* Effect.forkChild(
        Effect.succeed("gauntlet").pipe(Effect.delay("1 hour")),
      )
      yield* TestClock.adjust("1 hour")
      expect(yield* Fiber.join(fiber)).toBe("gauntlet")
    }))
})
