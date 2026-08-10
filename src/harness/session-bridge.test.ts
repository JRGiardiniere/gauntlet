import { describe, expect, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as TestClock from "effect/testing/TestClock"
import {
  AdapterContractViolation,
  SessionOpenError,
} from "./harness-session.ts"
import {
  abortAbandonedSession,
  finalizeCapture,
  makeCaptureState,
  openCapturedSession,
  type OpenSessionConfig,
  type SessionCaptureState,
} from "./session-bridge.ts"
import {
  makeScripted,
  type ScriptedBehavior,
  scriptedLayer,
  usageRow,
} from "./scripted.ts"

// The bridge under test is the bridge that ships (#17): these tests drive the
// shared session mechanics through the scripted adapter — the identical
// Promise/callback surface the live Pi session has — on the TestClock.

const CONFIG: OpenSessionConfig = {
  systemPrompt: "fixture system prompt",
  emitTool: {
    name: "emit_fixture",
    description: "fixture emit tool",
    parameters: { type: "object" },
  },
}

const GOOD_EMIT = { findings: [{ file: "src/alpha.ts", summary: "fixture" }] }

// Open a session, prompt it, and hold the scope open until the prompt
// settles — the shape every invocation above the seam follows.
const promptToCompletion = (
  behavior: ScriptedBehavior,
  state: SessionCaptureState,
) => {
  const scripted = makeScripted(behavior)
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* openCapturedSession(CONFIG, state)
          yield* Effect.promise(() => opened.session.prompt("review this"))
          return yield* Queue.takeAll(opened.events)
        }),
      ).pipe(Effect.provide(scriptedLayer(scripted))),
    )
    yield* TestClock.adjust(Duration.minutes(30))
    const events = yield* Fiber.join(fiber)
    return { events, log: scripted.log }
  })
}

const cleanupTail = (log: ReadonlyArray<string>) =>
  log.filter((entry) => ["unsubscribe", "usage-read", "dispose"].includes(entry))

describe("session bridge (scripted adapter, TestClock)", () => {
  it.effect("captures emit, terminal state, and swept usage through one run", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const { events, log } = yield* promptToCompletion(
        {
          events: [
            { afterMillis: 1_000, kind: "message_start" },
            { afterMillis: 2_000, kind: "emit", args: GOOD_EMIT, valid: true },
            {
              afterMillis: 3_000,
              kind: "message_end",
              stopReason: "toolUse",
              usage: usageRow(),
            },
          ],
          promptSettles: "after-events",
        },
        state,
      )

      // Capture happened synchronously in the listener: the validated emit
      // AND its raw pre-validation args are both recorded.
      expect(state.hasValidatedEmit).toBe(true)
      expect(state.validatedEmit).toEqual(GOOD_EMIT)
      expect(state.hasSalvagedEmit).toBe(true)
      expect(state.stopReason).toBe("toolUse")

      // The Queue carried the same events across fibers, in order.
      expect(events.map((event) => event.type)).toEqual([
        "message_start",
        "tool_execution_start",
        "message_end",
      ])

      // Cleanup ordering (LIFO finalizers): unsubscribe → sweep → dispose,
      // each exactly once.
      expect(cleanupTail(log)).toEqual(["unsubscribe", "usage-read", "dispose"])

      const result = yield* finalizeCapture(state)
      expect(result.usageRows).toEqual([usageRow()])
      expect(result.rawUsageRows).toEqual([usageRow()])
      expect(result.hasValidatedEmit).toBe(true)
    }))

  it.effect("interruptible acquire: a caller timeout cuts a hanging open loose", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const scripted = makeScripted({
        openDelayMillis: 120_000,
        events: [],
        promptSettles: "never",
      })
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          openCapturedSession(CONFIG, state).pipe(
            Effect.timeoutOption(Duration.millis(60_000)),
          ),
        ).pipe(Effect.provide(scriptedLayer(scripted))),
      )
      // The fiber must settle AT the timeout — with the default
      // uninterruptible acquire it would still be stuck inside open here.
      yield* TestClock.adjust(Duration.millis(60_000))
      const outcome = yield* Fiber.join(fiber)
      expect(Option.isNone(outcome)).toBe(true)
      // No session was ever acquired: nothing to sweep, nothing to dispose.
      expect(scripted.log).toEqual(["open"])
    }))

  it.effect("release ordering survives external interruption, sweep included", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const scripted = makeScripted({
        events: [
          { afterMillis: 1_000, kind: "message_start" },
          {
            afterMillis: 2_000,
            kind: "message_end",
            stopReason: "toolUse",
            usage: usageRow(),
          },
        ],
        promptSettles: "never",
      })
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* openCapturedSession(CONFIG, state)
            yield* Effect.promise(() => opened.session.prompt("review this"))
          }),
        ).pipe(Effect.provide(scriptedLayer(scripted))),
      )
      yield* TestClock.adjust(Duration.millis(5_000))
      yield* Fiber.interrupt(fiber)

      expect(cleanupTail(scripted.log)).toEqual([
        "unsubscribe",
        "usage-read",
        "dispose",
      ])
      // Accounting captured before the interrupt survives it.
      const result = yield* finalizeCapture(state)
      expect(result.usageRows).toHaveLength(1)
      expect(result.stopReason).toBe("toolUse")
    }))

  it.effect("a hanging abort never sits on the critical path", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const scripted = makeScripted({
        events: [],
        promptSettles: "never",
        abortBehavior: "hangs",
      })
      yield* Effect.scoped(
        Effect.gen(function* () {
          const opened = yield* openCapturedSession(CONFIG, state)
          yield* abortAbandonedSession(opened.session)
        }),
      ).pipe(Effect.provide(scriptedLayer(scripted)))
      // The abort was fired and never settles — yet the scope closed and the
      // session was disposed.
      expect(scripted.log).toContain("abort")
      expect(scripted.log).toContain("dispose")
    }))

  it.effect("a salvage-only emit is recorded as salvaged, never validated", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      yield* promptToCompletion(
        {
          events: [
            { afterMillis: 1_000, kind: "message_start" },
            { afterMillis: 2_000, kind: "emit", args: GOOD_EMIT, valid: false },
            {
              afterMillis: 3_000,
              kind: "message_end",
              stopReason: "stop",
              usage: usageRow(),
            },
          ],
          promptSettles: "after-events",
        },
        state,
      )
      const result = yield* finalizeCapture(state)
      expect(result.hasValidatedEmit).toBe(false)
      expect(result.hasSalvagedEmit).toBe(true)
      expect(result.salvagedEmit).toEqual(GOOD_EMIT)
    }))

  it.effect("drifted usage rows fail loudly even when an emit was captured", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      yield* promptToCompletion(
        {
          events: [
            { afterMillis: 1_000, kind: "emit", args: GOOD_EMIT, valid: true },
            {
              afterMillis: 2_000,
              kind: "message_end",
              stopReason: "toolUse",
            },
          ],
          promptSettles: "after-events",
          // The demonstrated hazard (#4 §8): a renamed field reads as absent
          // and every total silently becomes $0 — unless it fails here.
          sweptUsageRows: [{ ...usageRow(), cost: undefined }],
        },
        state,
      )
      expect(state.hasValidatedEmit).toBe(true)
      const failure = yield* Effect.flip(finalizeCapture(state))
      expect(failure).toBeInstanceOf(AdapterContractViolation)
    }))

  it.effect("a non-finite usage field is drift, not a $NaN total", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      yield* promptToCompletion(
        {
          events: [
            {
              afterMillis: 1_000,
              kind: "message_end",
              stopReason: "toolUse",
              usage: usageRow({ cost: { total: Number.NaN } }),
            },
          ],
          promptSettles: "after-events",
        },
        state,
      )
      const failure = yield* Effect.flip(finalizeCapture(state))
      expect(failure).toBeInstanceOf(AdapterContractViolation)
    }))

  it.effect("an adapter contract_violation event poisons the invocation", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      yield* promptToCompletion(
        {
          events: [
            {
              afterMillis: 1_000,
              kind: "violation",
              reason: "assistant message_end did not decode",
            },
            { afterMillis: 2_000, kind: "emit", args: GOOD_EMIT, valid: true },
            {
              afterMillis: 3_000,
              kind: "message_end",
              stopReason: "toolUse",
              usage: usageRow(),
            },
          ],
          promptSettles: "after-events",
        },
        state,
      )
      expect(state.hasValidatedEmit).toBe(true)
      const failure = yield* Effect.flip(finalizeCapture(state))
      expect(failure).toBeInstanceOf(AdapterContractViolation)
      expect(String(failure.reason)).toContain("message_end did not decode")
    }))

  it.effect("a sweep that throws is a contract violation, never silent", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      yield* promptToCompletion(
        {
          events: [
            {
              afterMillis: 1_000,
              kind: "message_end",
              stopReason: "toolUse",
              usage: usageRow(),
            },
          ],
          promptSettles: "after-events",
          failUsageSweep: "messages detached before sweep",
        },
        state,
      )
      const failure = yield* Effect.flip(finalizeCapture(state))
      expect(failure).toBeInstanceOf(AdapterContractViolation)
      expect(failure.reason).toContain("usage sweep threw")
    }))

  it.effect("a failed open is a typed SessionOpenError", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const scripted = makeScripted({
        failOpen: "no credentials for provider",
        events: [],
        promptSettles: "never",
      })
      const failure = yield* Effect.scoped(openCapturedSession(CONFIG, state)).pipe(
        Effect.provide(scriptedLayer(scripted)),
        Effect.flip,
      )
      expect(failure).toBeInstanceOf(SessionOpenError)
      expect(failure.reason).toBe("no credentials for provider")
    }))

  it.effect("an empty system prompt is rejected before any session opens", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const scripted = makeScripted({ events: [], promptSettles: "never" })
      const failure = yield* Effect.scoped(
        openCapturedSession({ ...CONFIG, systemPrompt: "" }, state),
      ).pipe(Effect.provide(scriptedLayer(scripted)), Effect.flip)
      expect(failure).toBeInstanceOf(SessionOpenError)
      expect(failure.operation).toBe("validate-config")
      // Pi treats an empty prompt as "use the stock prompt", so the open must
      // never be attempted at all.
      expect(scripted.log).toEqual([])
    }))

  it.effect("a duplicate validated emit keeps the first and counts the extras", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      yield* promptToCompletion(
        {
          events: [
            { afterMillis: 1_000, kind: "emit", args: GOOD_EMIT, valid: true },
            {
              afterMillis: 2_000,
              kind: "emit",
              args: { findings: [] },
              valid: true,
            },
            {
              afterMillis: 3_000,
              kind: "message_end",
              stopReason: "toolUse",
              usage: usageRow(),
            },
          ],
          promptSettles: "after-events",
        },
        state,
      )
      // Never silently last-wins: the first call is the emit, extras are
      // counted for the invocation engine to judge (#18).
      const result = yield* finalizeCapture(state)
      expect(result.validatedEmit).toEqual(GOOD_EMIT)
      expect(result.duplicateValidatedEmits).toBe(1)
    }))

  it.effect("a re-prompt after the script has played settles instead of hanging", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const scripted = makeScripted({
        events: [
          {
            afterMillis: 1_000,
            kind: "message_end",
            stopReason: "stop",
            usage: usageRow(),
          },
        ],
        promptSettles: "after-events",
      })
      const fiber = yield* Effect.forkChild(
        Effect.scoped(
          Effect.gen(function* () {
            const opened = yield* openCapturedSession(CONFIG, state)
            yield* Effect.promise(() => opened.session.prompt("review this"))
            // The corrective-turn shape (#18): re-prompt the same session
            // after a clean stop.
            yield* Effect.promise(() =>
              opened.session.prompt("you stopped without emitting"),
            )
          }),
        ).pipe(Effect.provide(scriptedLayer(scripted))),
      )
      yield* TestClock.adjust(Duration.minutes(30))
      yield* Fiber.join(fiber)
      expect(scripted.log.filter((entry) => entry === "prompt")).toHaveLength(2)
    }))

  it.effect("an unserializable drifted row still fails typed, not as a defect", () =>
    Effect.gen(function* () {
      const state = makeCaptureState()
      const circular: { self?: unknown } = {}
      circular.self = circular
      yield* promptToCompletion(
        {
          events: [
            {
              afterMillis: 1_000,
              kind: "message_end",
              stopReason: "toolUse",
              usage: usageRow(),
            },
          ],
          promptSettles: "after-events",
          // JSON.stringify throws on this row; the violation message must
          // survive that rather than turning into a defect.
          sweptUsageRows: [circular],
        },
        state,
      )
      const failure = yield* Effect.flip(finalizeCapture(state))
      expect(failure).toBeInstanceOf(AdapterContractViolation)
    }))
})
