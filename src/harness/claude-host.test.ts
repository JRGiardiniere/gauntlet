import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { Termination } from "../domain/agent-outcome.ts"
import {
  type ClaudeHost,
  type ClaudeHostCommand,
  type ClaudeTurnEnding,
  makeClaudeHost,
} from "./claude-host.ts"
import { HarnessSessionFactory } from "./harness-session.ts"
import { invoke, type InvokeInput } from "./invoke.ts"
import { EmitFindings, type FindingsOutput } from "./output-contract.ts"

const INPUT: InvokeInput<FindingsOutput> = {
  invocationId: "fixture-invocation",
  seat: "claude-code/fixture-model:low",
  cwd: "/fixture/snapshot",
  systemPrompt: "finder system prompt",
  prompt: "review this diff",
  contract: EmitFindings,
  tools: ["read"],
  deadlines: {
    overallMillis: 60_000,
    startupMillis: 5_000,
    firstResponseMillis: 10_000,
    toolMillis: 2_000,
    bashMillis: 20_000,
  },
}

const EMIT: FindingsOutput = {
  findings: [{ file: "src/a.ts", summary: "off-by-one in pagination" }],
}

// Plays the mod's part: opens every session, and answers each prompt with
// what the turn's hooks would report.
const invokeOver = (
  turn: (host: ClaudeHost, id: string) => ClaudeTurnEnding,
) =>
  Effect.gen(function* () {
    let host: ClaudeHost | undefined
    const send = (command: ClaudeHostCommand) =>
      queueMicrotask(() => {
        if (host === undefined) return
        if (command.kind === "open") host.opened(command.id, undefined)
        if (command.kind === "prompt") host.ended(command.id, turn(host, command.id))
      })
    host = makeClaudeHost(() => undefined, send)
    return yield* invoke(INPUT).pipe(
      Effect.provideService(HarnessSessionFactory, host.factory),
    )
  })

describe("the Claude Code host", () => {
  it.effect("ends an invocation whose subagent a person stopped as Interrupted", () =>
    Effect.gen(function* () {
      const outcome = yield* invokeOver(() => ({ reason: "aborted" }))

      expect(Termination.guards.Interrupted(outcome.termination)).toBe(true)
    }))

  // Claude Code retries a max_tokens response, then ends the turn as an error.
  it.effect("ends an invocation whose last response hit the token limit as ContextLimit", () =>
    Effect.gen(function* () {
      const outcome = yield* invokeOver((host, id) => {
        host.event(id, {
          type: "message_end",
          stopReason: "max_tokens",
          usage: { input_tokens: 2, output_tokens: 64, model: "claude-fixture" },
        })
        return { reason: "error", detail: "" }
      })

      expect(Termination.guards.ContextLimit(outcome.termination)).toBe(true)
    }))

  it.effect("counts an unpriced model's tokens at $0 rather than failing the run", () =>
    Effect.gen(function* () {
      const outcome = yield* invokeOver((host, id) => {
        host.emit(id, EMIT)
        host.event(id, {
          type: "message_end",
          stopReason: "tool_use",
          usage: { input_tokens: 1200, output_tokens: 80, model: "claude-unpriced-9" },
        })
        return { reason: "answer" }
      })

      expect(Termination.guards.Completed(outcome.termination)).toBe(true)
      expect(outcome.usage.input).toBe(1200)
      expect(outcome.usage.costUsd).toBe(0)
    }))
})
