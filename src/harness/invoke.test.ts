import { describe, expect, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import { Termination } from "../domain/agent-outcome.ts"
import {
  invoke,
  invokeSignaled,
  type InvokeInput,
  PrefixSignal,
} from "./invoke.ts"
import { EmitFindings, type FindingsOutput } from "./output-contract.ts"
import {
  makeScripted,
  scriptedLayer,
  type ScriptedBehavior,
  type ScriptedTurn,
  usageRow,
} from "./scripted.ts"

// One AgentInvocation at the turn seam: the scripted Host plays turns, and
// the invocation decides corrective turns, the deadline and the outcome.

const DEADLINE_MILLIS = 60_000

const INPUT: InvokeInput<FindingsOutput> = {
  invocationId: "fixture-invocation",
  role: "finder-1",
  seat: "fixture/fixture-model:low",
  workspace: "/fixture/snapshot",
  systemPrompt: "finder system prompt",
  prompt: "review this diff",
  contract: EmitFindings,
  tools: ["read", "grep", "glob"],
  deadlineMillis: DEADLINE_MILLIS,
}

const GOOD_EMIT: FindingsOutput = {
  findings: [
    {
      file: "src/a.ts",
      line: 12,
      summary: "off-by-one in pagination",
      failure_scenario: "page size 0 loops forever",
    },
    { file: "src/b.ts", summary: "misleading variable name" },
  ],
}

const emitting: ScriptedTurn = { afterMillis: 300, emits: [GOOD_EMIT] }
const stopping: ScriptedTurn = { afterMillis: 300 }

const run = (behavior: ScriptedBehavior, input: InvokeInput<FindingsOutput> = INPUT) =>
  Effect.gen(function* () {
    const scripted = makeScripted(behavior)
    const fiber = yield* invoke(input).pipe(Effect.provide(scriptedLayer(scripted)), Effect.forkChild)
    yield* TestClock.adjust(Duration.millis(input.deadlineMillis + 1))
    return { outcome: yield* Fiber.join(fiber), scripted }
  })

const runFailure = (behavior: ScriptedBehavior, input: InvokeInput<FindingsOutput> = INPUT) =>
  Effect.gen(function* () {
    const scripted = makeScripted(behavior)
    const fiber = yield* invoke(input).pipe(Effect.provide(scriptedLayer(scripted)), Effect.flip, Effect.forkChild)
    yield* TestClock.adjust(Duration.millis(input.deadlineMillis + 1))
    return yield* Fiber.join(fiber)
  })

describe("invoke", () => {
  it.effect("completes on a validated emit and keeps its decoded output, usage and tool calls", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [{
          turns: [{
            afterMillis: 300,
            emits: [GOOD_EMIT],
            usage: [usageRow({ input: 10 }), usageRow({ input: 20, cacheRead: 5 })],
            toolCalls: { total: 3, errored: 1 },
          }],
        }],
      })

      expect(outcome.termination).toEqual(Termination.cases.Completed.make({}))
      expect(outcome.output).toEqual(GOOD_EMIT)
      expect(outcome.usage).toMatchObject({ input: 30, output: 400, cacheRead: 805, cacheWrite: 200, reasoning: 100 })
      expect(outcome.usage.rawRows).toHaveLength(2)
      expect(outcome.toolCalls).toEqual({ total: 3, errored: 1 })
      expect(outcome.durationMillis).toBe(300)
      expect(outcome.diagnostics).toEqual([])
      expect(scripted.log).toEqual(["open:1", "turn:1.1", "close:1"])
      expect(scripted.specs[0]).toMatchObject({
        role: "finder-1",
        workspace: "/fixture/snapshot",
        systemPrompt: "finder system prompt",
        tools: ["read", "grep", "glob"],
      })
      expect(scripted.specs[0]?.emit.name).toBe("emit_findings")
    }))

  it.effect("returns an emit the strict decoder rejects to the model inside the same turn", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [{
          turns: [{ emits: [{ findings: [{ file: "a.ts", summary: "s", extra: true }] }, GOOD_EMIT] }],
        }],
      })

      expect(outcome.termination._tag).toBe("Completed")
      expect(outcome.output).toEqual(GOOD_EMIT)
      expect(scripted.prompts).toHaveLength(1)
      expect(outcome.diagnostics).toHaveLength(1)
      expect(outcome.diagnostics[0]).toMatch(/^emit_findings rejected: /)
    }))

  it.effect("re-prompts the same session up to twice when a turn ends without an emit", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [{ turns: [stopping, stopping, emitting] }],
      })

      expect(outcome.termination._tag).toBe("Completed")
      expect(outcome.output).toEqual(GOOD_EMIT)
      expect(outcome.usage.rawRows).toHaveLength(3)
      expect(scripted.log).toEqual(["open:1", "turn:1.1", "turn:1.2", "turn:1.3", "close:1"])
      expect(scripted.prompts[1]?.text).toContain("You ended without calling emit_findings")
      expect(outcome.diagnostics).toEqual(["validated emit succeeded after 2 corrective turns"])
    }))

  it.effect("ends MissingEmit after two corrective turns without an emit", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [{ turns: [stopping, stopping, stopping, emitting] }],
      })

      expect(outcome.termination).toEqual(Termination.cases.MissingEmit.make({ correctiveTurns: 2 }))
      expect(outcome.output).toBeUndefined()
      expect(scripted.prompts).toHaveLength(3)
      expect(outcome.usage.rawRows).toHaveLength(3)
    }))

  it.effect.each([
    { ending: { _tag: "ContextLimit" }, termination: "ContextLimit", diagnostic: "context limit reached" },
    {
      ending: { _tag: "ProviderFailed", reason: "529 overloaded" },
      termination: "ProviderFailed",
      diagnostic: "provider failed: 529 overloaded",
    },
    {
      ending: { _tag: "Interrupted", reason: "stopped from outside" },
      termination: "Interrupted",
      diagnostic: "interrupted: stopped from outside",
    },
  ] as const)("ends $termination with no corrective turn, keeping the turn's usage", ({ ending, termination, diagnostic }) =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({ sessions: [{ turns: [{ ending }, emitting] }] })

      expect(outcome.termination._tag).toBe(termination)
      expect(outcome.output).toBeUndefined()
      expect(outcome.diagnostics).toEqual([diagnostic])
      expect(outcome.usage.rawRows).toHaveLength(1)
      expect(scripted.prompts).toHaveLength(1)
    }))

  it.effect("ends BudgetExhausted at the one overall deadline, corrective turns included, and closes the session", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [{
          turns: [
            { afterMillis: 20_000 },
            { afterMillis: 20_000 },
            { ending: { _tag: "Hangs" }, usage: [usageRow({ input: 7 }), usageRow({ input: 9 })] },
          ],
        }],
      })

      expect(outcome.termination).toEqual(Termination.cases.BudgetExhausted.make({}))
      expect(outcome.durationMillis).toBe(DEADLINE_MILLIS)
      // The two turns that ended, then what the cut turn had already spent.
      expect(outcome.usage.rawRows).toHaveLength(4)
      expect(outcome.usage.input).toBe(2_016)
      expect(outcome.diagnostics).toEqual(["overall invocation deadline exhausted"])
      expect(scripted.log).toEqual(["open:1", "turn:1.1", "turn:1.2", "turn:1.3", "cut:1", "close:1"])
    }))

  it.effect("fails with InvocationSetupError when the session cannot open", () =>
    Effect.gen(function* () {
      const failure = yield* runFailure({ sessions: [{ failOpen: "agent not available", turns: [] }] })
      expect(failure).toMatchObject({ _tag: "InvocationSetupError", reason: "agent not available" })
    }))

  it.effect("fails with AdapterContractViolation when the Host breaks its contract", () =>
    Effect.gen(function* () {
      const failure = yield* runFailure({ sessions: [{ turns: [stopping] }] })
      expect(failure).toMatchObject({ _tag: "AdapterContractViolation", reason: "no scripted turn 2 for open 1" })
    }))

  it.effect("rejects an empty prompt before opening a session", () =>
    Effect.gen(function* () {
      const failure = yield* runFailure({ sessions: [{ turns: [emitting] }] }, { ...INPUT, prompt: "  " })
      expect(failure).toMatchObject({ _tag: "InvocationSetupError", reason: "prompt must be non-empty" })
    }))
})

describe("invokeSignaled", () => {
  const signaled = (behavior: ScriptedBehavior) =>
    Effect.gen(function* () {
      const scripted = makeScripted(behavior)
      const running = yield* invokeSignaled(INPUT).pipe(Effect.provide(scriptedLayer(scripted)))
      const signal = yield* running.firstResponse.pipe(Effect.forkChild)
      return { running, signal }
    })

  it.effect("signals PrefixObserved at the first streamed token, before the invocation ends", () =>
    Effect.gen(function* () {
      const { running, signal } = yield* signaled({
        sessions: [{ firstTokenAfterMillis: 100, turns: [{ afterMillis: 5_000, emits: [GOOD_EMIT] }] }],
      })
      const outcome = yield* running.outcome.pipe(Effect.forkChild)
      yield* TestClock.adjust(Duration.millis(100))
      const observed = yield* Fiber.join(signal)
      expect(observed).toEqual(PrefixSignal.PrefixObserved())
      expect(outcome.pollUnsafe()).toBeUndefined()
      yield* TestClock.adjust(Duration.millis(5_000))
      const ended = yield* Fiber.join(outcome)
      expect(ended.termination._tag).toBe("Completed")
    }).pipe(Effect.scoped))

  it.effect("signals PrefixNotObserved when the invocation ends without a first token", () =>
    Effect.gen(function* () {
      const { running, signal } = yield* signaled({
        sessions: [{ firstTokenAfterMillis: "never", turns: [{ afterMillis: 1_000, ending: { _tag: "ProviderFailed", reason: "down" } }] }],
      })
      yield* TestClock.adjust(Duration.millis(1_000))
      const observed = yield* Fiber.join(signal)
      expect(observed).toEqual(PrefixSignal.PrefixNotObserved())
      const outcome = yield* running.outcome
      expect(outcome.termination._tag).toBe("ProviderFailed")
    }).pipe(Effect.scoped))
})
