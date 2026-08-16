import { describe, expect, it } from "@effect/vitest"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as TestClock from "effect/testing/TestClock"
import { Termination } from "../domain/agent-outcome.ts"
import {
  AdapterContractViolation,
  type EmitToolArgs,
  InvocationSetupError,
} from "./harness-session.ts"
import {
  invoke,
  type InvokeInput,
  preloadConversation,
} from "./invoke.ts"
import {
  EmitFindings,
  type FindingsOutput,
} from "./output-contract.ts"
import {
  makeScripted,
  scriptedLayer,
  type ScriptedBehavior,
  type ScriptedPrompt,
  usageRow,
} from "./scripted.ts"

const INPUT: InvokeInput<FindingsOutput> = {
  invocationId: "fixture-invocation",
  seat: "fixture/fixture-model:low",
  cwd: "/fixture/repo",
  systemPrompt: "finder system prompt",
  prompt: "review this diff",
  contract: EmitFindings,
  tools: ["read", "bash"],
  deadlines: {
    overallMillis: 60_000,
    startupMillis: 5_000,
    firstResponseMillis: 10_000,
    toolMillis: 2_000,
    bashMillis: 20_000,
  },
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

const OTHER_EMIT: FindingsOutput = {
  findings: [{ file: "src/new.ts", summary: "newer recoverable output" }],
}

const makeExplicitCancellation = () => new AbortController()

const completedPrompt = (emit: EmitToolArgs = GOOD_EMIT): ScriptedPrompt => ({
  events: [
    { afterMillis: 100, kind: "message_start" },
    { afterMillis: 200, kind: "emit", args: emit, valid: true },
    { afterMillis: 300, kind: "message_end", stopReason: "toolUse" },
  ],
  settles: "after-events",
})

const advanceUntilComplete = <A, E>(
  fiber: Fiber.Fiber<A, E>,
  maxMillis: number,
) =>
  Effect.gen(function* () {
    const stepMillis = 250
    for (let elapsed = 0; elapsed <= maxMillis; elapsed += stepMillis) {
      if (fiber.pollUnsafe() !== undefined) {
        return yield* Fiber.join(fiber)
      }
      yield* TestClock.adjust(Duration.millis(stepMillis))
      yield* Effect.yieldNow
    }
    return yield* Fiber.join(fiber)
  })

const run = (
  behavior: ScriptedBehavior,
  input: InvokeInput<FindingsOutput> = INPUT,
) => {
  const scripted = makeScripted(behavior)
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      invoke(input).pipe(Effect.provide(scriptedLayer(scripted))),
    )
    const outcome = yield* advanceUntilComplete(
      fiber,
      input.deadlines.overallMillis + input.deadlines.startupMillis + 1,
    )
    return { outcome, scripted }
  })
}

const runFailure = (
  behavior: ScriptedBehavior,
  input: InvokeInput<FindingsOutput> = INPUT,
) => {
  const scripted = makeScripted(behavior)
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      invoke(input).pipe(
        Effect.provide(scriptedLayer(scripted)),
        Effect.flip,
      ),
    )
    const failure = yield* advanceUntilComplete(
      fiber,
      input.deadlines.overallMillis + input.deadlines.startupMillis + 1,
    )
    return { failure, scripted }
  })
}

const runPreload = (behavior: ScriptedBehavior) => {
  const scripted = makeScripted(behavior)
  const { contract, ...preloadInput } = INPUT
  return Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(
      preloadConversation({
        ...preloadInput,
        prompt: "shared finder context\n\n## Finder context preload",
        cacheGroupId: "fixture-cache-group",
        followerContract: contract,
        expectedAcknowledgment: "Context loaded.",
      }).pipe(Effect.provide(scriptedLayer(scripted))),
    )
    const result = yield* advanceUntilComplete(
      fiber,
      INPUT.deadlines.overallMillis + INPUT.deadlines.startupMillis + 1,
    )
    return { result, scripted }
  })
}

const cleanStop = (): ScriptedPrompt => ({
  events: [
    { afterMillis: 100, kind: "message_start" },
    { afterMillis: 200, kind: "message_end", stopReason: "stop" },
  ],
  settles: "after-events",
})

describe("invoke (scripted HarnessSession, TestClock)", () => {
  it.effect("captures the actual preload acknowledgment as a replayable prefix", () =>
    Effect.gen(function* () {
      const { result, scripted } = yield* runPreload({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  { afterMillis: 200, kind: "message_end", stopReason: "stop" },
                ],
                settles: "after-events",
                assistantText: "Context loaded.",
              },
            ],
          },
        ],
      })

      expect(Termination.guards.Completed(result.outcome.termination)).toBe(true)
      expect(result.outcome.output).toEqual({
        acknowledgment: "Context loaded.",
      })
      expect(result.conversationPrefix).toBeDefined()
      expect(scripted.configs[0]?.mode).toBe("preload")
      expect(scripted.prefixes[0]?.userPrompt).toBe(
        "shared finder context\n\n## Finder context preload",
      )
      expect(scripted.prefixes[0]?.prefix).toBe(result.conversationPrefix)
    }))

  it.effect("blocks every preload tool before workspace or emit execution", () =>
    Effect.gen(function* () {
      const { result, scripted } = yield* runPreload({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  {
                    afterMillis: 150,
                    kind: "tool",
                    toolName: "read",
                    args: { path: "secret.txt" },
                  },
                  {
                    afterMillis: 175,
                    kind: "emit",
                    args: GOOD_EMIT,
                    valid: true,
                  },
                  {
                    afterMillis: 200,
                    kind: "message_end",
                    stopReason: "toolUse",
                  },
                ],
                settles: "after-events",
                assistantText: "not reusable",
              },
            ],
          },
        ],
      })

      expect(Termination.guards.ProviderFailed(result.outcome.termination)).toBe(
        true,
      )
      expect(result.outcome.output).toBeUndefined()
      expect(result.conversationPrefix).toBeUndefined()
      expect(scripted.inspections).toEqual([
        expect.objectContaining({
          toolName: "read",
          isError: true,
          text: "finder preload cannot call workspace tools",
        }),
      ])
      expect(result.outcome.diagnostics.join(" ")).toContain(
        "forbidden tool calls",
      )
    }))

  it.effect("rejects non-contract preload prose without replaying it", () =>
    Effect.gen(function* () {
      const { result } = yield* runPreload({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  { afterMillis: 200, kind: "message_end", stopReason: "stop" },
                ],
                settles: "after-events",
                assistantText: "Sure, I loaded the context.",
              },
            ],
          },
        ],
      })

      expect(Termination.guards.ProviderFailed(result.outcome.termination)).toBe(
        true,
      )
      expect(result.outcome.output).toBeUndefined()
      expect(result.conversationPrefix).toBeUndefined()
      expect(result.outcome.diagnostics.join(" ")).toContain(
        "acknowledgment did not exactly match",
      )
    }))

  it.effect("returns a metered preload outcome after provider rejection from activity", () =>
    Effect.gen(function* () {
      const { result, scripted } = yield* runPreload({
        sessions: [
          {
            prompts: [
              {
                events: [{ afterMillis: 100, kind: "message_start" }],
                settles: "after-events",
                reject: "upstream connection closed",
                assistantText: "Context loaded.",
              },
            ],
          },
        ],
      })

      expect(Termination.guards.ProviderFailed(result.outcome.termination)).toBe(
        true,
      )
      expect(result.conversationPrefix).toBeUndefined()
      expect(scripted.prefixes).toEqual([])
      expect(result.outcome.diagnostics.join(" ")).toContain(
        "provider rejected preload after accepting session activity",
      )
    }))

  it.effect("retries one first-response stall in a fresh session", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [
          {
            prompts: [{ events: [], settles: "never" }],
            abortBehavior: "hangs",
          },
          { prompts: [completedPrompt()] },
        ],
      })

      expect(Termination.guards.Completed(outcome.termination)).toBe(true)
      expect(scripted.log.filter((entry) => entry.startsWith("open:"))).toEqual([
        "open:1",
        "open:2",
      ])
      expect(scripted.log).toContain("abort:1")
      expect(scripted.log).toContain("prompt:1.1")
      expect(scripted.log).toContain("prompt:2.1")
      expect(outcome.diagnostics.join(" ")).toContain("fresh session")
    }))

  it.effect(
    "retains the first timeout outcome when the fresh retry cannot start",
    () =>
      Effect.gen(function* () {
        const { outcome, scripted } = yield* run({
          sessions: [
            {
              prompts: [{ events: [], settles: "never" }],
              abortBehavior: "hangs",
            },
            { failOpen: "retry unavailable", prompts: [] },
          ],
        })

        expect(
          Termination.guards.FirstResponseTimeout(outcome.termination),
        ).toBe(true)
        expect(
          scripted.log.filter((entry) => entry.startsWith("open:")),
        ).toEqual(["open:1", "open:2"])
        expect(outcome.diagnostics.join(" ")).toContain("retry unavailable")
        expect(outcome.diagnostics.join(" ")).toContain(
          "retained the first-response timeout outcome",
        )
      }),
  )

  it.effect("folds a startup stall into the same one-fresh-session retry", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [
          { openDelayMillis: 10_000, prompts: [] },
          { prompts: [completedPrompt()] },
        ],
      })
      expect(Termination.guards.Completed(outcome.termination)).toBe(true)
      expect(scripted.log.filter((entry) => entry.startsWith("open:"))).toEqual([
        "open:1",
        "open:2",
      ])
      expect(scripted.log).not.toContain("dispose:1")
    }))

  it.effect("uses corrective turns on the same clean session", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [{ prompts: [cleanStop(), completedPrompt()] }],
      })
      expect(Termination.guards.Completed(outcome.termination)).toBe(true)
      expect(scripted.log.filter((entry) => entry.startsWith("open:"))).toEqual([
        "open:1",
      ])
      expect(scripted.log.filter((entry) => entry.startsWith("prompt:"))).toEqual([
        "prompt:1.1",
        "prompt:1.2",
      ])
      expect(outcome.diagnostics.join(" ")).toContain("1 corrective turn")
    }))

  it.effect("records missing emit after exactly two corrective turns", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [{ prompts: [cleanStop(), cleanStop(), cleanStop()] }],
      })
      expect(Termination.guards.MissingEmit(outcome.termination)).toBe(true)
      if (Termination.guards.MissingEmit(outcome.termination)) {
        expect(outcome.termination.correctiveTurns).toBe(2)
      }
      expect(scripted.log.filter((entry) => entry.startsWith("prompt:"))).toHaveLength(3)
    }))

  it.effect("never retries or corrects a context-limit ending", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  {
                    afterMillis: 200,
                    kind: "message_end",
                    stopReason: "length",
                  },
                ],
                settles: "after-events",
              },
            ],
          },
        ],
      })
      expect(Termination.guards.ContextLimit(outcome.termination)).toBe(true)
      expect(scripted.log.filter((entry) => entry.startsWith("open:"))).toHaveLength(1)
      expect(scripted.log.filter((entry) => entry.startsWith("prompt:"))).toHaveLength(1)
    }))

  it.effect("keeps output and usage beside provider failure", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  {
                    afterMillis: 150,
                    kind: "emit",
                    args: GOOD_EMIT,
                    valid: true,
                  },
                  {
                    afterMillis: 200,
                    kind: "message_end",
                    stopReason: "error",
                    errorMessage: "upstream 529",
                    usage: usageRow({ cost: { total: 0.01 } }),
                  },
                ],
                settles: "after-events",
              },
            ],
          },
        ],
      })
      expect(Termination.guards.ProviderFailed(outcome.termination)).toBe(true)
      expect(outcome.output).toEqual(GOOD_EMIT)
      expect(outcome.usage.costUsd).toBeCloseTo(0.01)
      expect(outcome.diagnostics.join(" ")).toContain("upstream 529")
    }))

  it.effect("keeps captured output when the absolute budget wins", () =>
    Effect.gen(function* () {
      const { outcome, scripted } = yield* run({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  {
                    afterMillis: 200,
                    kind: "message_end",
                    stopReason: "toolUse",
                  },
                  {
                    afterMillis: 300,
                    kind: "emit",
                    args: GOOD_EMIT,
                    valid: true,
                  },
                ],
                settles: "never",
              },
            ],
            abortBehavior: "hangs",
          },
        ],
      })
      expect(Termination.guards.BudgetExhausted(outcome.termination)).toBe(true)
      expect(outcome.output).toEqual(GOOD_EMIT)
      expect(outcome.usage.costUsd).toBeCloseTo(0.05)
      expect(scripted.log).toContain("abort:1")
      expect(scripted.log.slice(-3)).toEqual([
        "unsubscribe:1",
        "usage-read:1",
        "dispose:1",
      ])
    }))

  it.effect("maps only explicit cancellation provenance to Interrupted", () =>
    Effect.gen(function* () {
      const controller = makeExplicitCancellation()
      const scripted = makeScripted({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  {
                    afterMillis: 200,
                    kind: "emit",
                    args: GOOD_EMIT,
                    valid: true,
                  },
                  {
                    afterMillis: 300,
                    kind: "message_end",
                    stopReason: "toolUse",
                  },
                ],
                settles: "never",
              },
            ],
          },
        ],
      })
      const fiber = yield* Effect.forkChild(
        invoke({ ...INPUT, signal: controller.signal }).pipe(
          Effect.provide(scriptedLayer(scripted)),
        ),
      )
      for (let step = 0; step < 8; step += 1) {
        yield* TestClock.adjust("250 millis")
        yield* Effect.yieldNow
        if (scripted.log.includes("event:1.1:emit")) break
      }
      expect(scripted.log).toContain("event:1.1:emit")
      controller.abort("user requested cancellation")
      const outcome = yield* Fiber.join(fiber)
      expect(Termination.guards.Interrupted(outcome.termination)).toBe(true)
      expect(outcome.output).toEqual(GOOD_EMIT)
      expect(outcome.diagnostics).toContain("explicit cancellation requested")
    }))

  it.effect("chooses the newest salvage candidate that strictly decodes", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  { afterMillis: 150, kind: "emit", args: GOOD_EMIT, valid: false },
                  { afterMillis: 175, kind: "emit", args: { findings: [{ nope: true }] }, valid: false },
                  { afterMillis: 200, kind: "emit", args: OTHER_EMIT, valid: false },
                  { afterMillis: 250, kind: "message_end", stopReason: "length" },
                ],
                settles: "after-events",
              },
            ],
          },
        ],
      })
      expect(Termination.guards.ContextLimit(outcome.termination)).toBe(true)
      expect(outcome.output).toEqual(OTHER_EMIT)
      expect(outcome.diagnostics.join(" ")).toContain("pre-validation")
    }))

  it.effect("validated output wins and duplicate calls retain the first", () =>
    Effect.gen(function* () {
      const { outcome } = yield* run({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  { afterMillis: 150, kind: "emit", args: OTHER_EMIT, valid: false },
                  { afterMillis: 200, kind: "emit", args: GOOD_EMIT, valid: true },
                  { afterMillis: 250, kind: "emit", args: OTHER_EMIT, valid: true },
                  { afterMillis: 300, kind: "message_end", stopReason: "toolUse" },
                ],
                settles: "after-events",
              },
            ],
          },
        ],
      })
      expect(outcome.output).toEqual(GOOD_EMIT)
      expect(outcome.diagnostics.join(" ")).toContain("retained the first")
    }))

  it.effect("rejects assistant activity after a validated final emit", () =>
    Effect.gen(function* () {
      const { failure } = yield* runFailure({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  {
                    afterMillis: 200,
                    kind: "emit",
                    args: GOOD_EMIT,
                    valid: true,
                  },
                  {
                    afterMillis: 300,
                    kind: "message_end",
                    stopReason: "toolUse",
                  },
                  { afterMillis: 400, kind: "message_start" },
                  {
                    afterMillis: 500,
                    kind: "message_end",
                    stopReason: "stop",
                  },
                ],
                settles: "after-events",
              },
            ],
          },
        ],
      })

      expect(failure).toBeInstanceOf(AdapterContractViolation)
      expect(failure.reason).toContain(
        "assistant activity continued after validated emit_findings",
      )
    }))

  it.effect("fails loudly on usage drift even after a validated emit", () =>
    Effect.gen(function* () {
      const { failure } = yield* runFailure({
        sessions: [
          {
            prompts: [completedPrompt()],
            sweptUsageRows: [{ input: 1, tokenUsage: 2 }],
          },
        ],
      })
      expect(failure).toBeInstanceOf(AdapterContractViolation)
      expect(failure.reason).toContain("accounting contract")
    }))

  it.effect("classifies prompt rejection from causal activity", () =>
    Effect.gen(function* () {
      const before = yield* runFailure({
        sessions: [
          {
            prompts: [
              { events: [], settles: "after-events", reject: "not accepted" },
            ],
          },
        ],
      })
      expect(before.failure).toBeInstanceOf(InvocationSetupError)

      const after = yield* runFailure({
        sessions: [
          {
            prompts: [
              {
                events: [{ afterMillis: 100, kind: "message_start" }],
                settles: "after-events",
                reject: "rejected after activity",
              },
            ],
          },
        ],
      })
      expect(after.failure).toBeInstanceOf(AdapterContractViolation)
    }))

  it.effect(
    "preserves adapter-contract evidence when the prompt also rejects",
    () =>
      Effect.gen(function* () {
        const { failure } = yield* runFailure({
          sessions: [
            {
              prompts: [
                {
                  events: [
                    {
                      afterMillis: 100,
                      kind: "violation",
                      reason: "message_start did not decode",
                    },
                  ],
                  settles: "after-events",
                  reject: "prompt rejected",
                },
              ],
            },
          ],
        })

        expect(failure).toBeInstanceOf(AdapterContractViolation)
        expect(failure.reason).toContain("message_start did not decode")
      }),
  )

  it.effect("treats uncaused aborted and missing terminal evidence as drift", () =>
    Effect.gen(function* () {
      const aborted = yield* runFailure({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  { afterMillis: 200, kind: "message_end", stopReason: "aborted" },
                ],
                settles: "after-events",
              },
            ],
          },
        ],
      })
      expect(aborted.failure).toBeInstanceOf(AdapterContractViolation)

      const missing = yield* runFailure({
        sessions: [
          {
            prompts: [
              {
                events: [{ afterMillis: 100, kind: "message_start" }],
                settles: "after-events",
              },
            ],
          },
        ],
      })
      expect(missing.failure).toBeInstanceOf(AdapterContractViolation)
      expect(missing.failure.reason).toContain("terminal assistant evidence")
    }))

  it.effect("retains raw usage in JSON-safe serialized form", () =>
    Effect.gen(function* () {
      const row = usageRow({ reasoning: undefined })
      const { outcome } = yield* run({
        sessions: [
          {
            prompts: [
              {
                events: [
                  { afterMillis: 100, kind: "message_start" },
                  { afterMillis: 200, kind: "emit", args: GOOD_EMIT, valid: true },
                  {
                    afterMillis: 300,
                    kind: "message_end",
                    stopReason: "toolUse",
                    usage: row,
                  },
                ],
                settles: "after-events",
              },
            ],
          },
        ],
      })
      expect(outcome.usage.reasoning).toBe(0)
      expect(outcome.usage.rawRows[0]).toEqual({
        input: 1000,
        output: 200,
        cacheRead: 800,
        cacheWrite: 100,
        cost: { total: 0.05 },
      })
    }))
})
