import type * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import {
  type HarnessEvent,
  type HarnessSession,
  type HarnessSessionFactoryContract,
  InvocationSetupError,
  type SessionConfig,
  type StopReason,
  type UsageRow,
} from "./harness-session.ts"

// The Claude Code host's core (#134): runs each AgentInvocation as a hidden
// Claude Code subagent that the Mod spawns, as a mapping with no
// invocation logic (deadlines, corrective turns, capture and accounting stay
// in invoke.ts). The review program runs inside the mod (mod/engine.ts): the
// core sends Commands out, and the mod's hooks report back what they saw —
// responses, tool calls, emit arguments and turn endings. Its mutable cells belong to
// the Promise and callback contract of HarnessSession.

export type ClaudeHostCommand =
  | {
    readonly kind: "open"
    readonly id: string
    readonly invocationId: string
    readonly seat: string
    readonly cwd: string
    readonly systemPrompt: string
    readonly emitTool: {
      readonly name: string
      readonly description: string
      readonly parameters: unknown
    }
    readonly tools: ReadonlyArray<string>
  }
  | { readonly kind: "prompt"; readonly id: string; readonly text: string; readonly turn: number }
  | { readonly kind: "abort"; readonly id: string }
  | { readonly kind: "dispose"; readonly id: string }

// The mod's reports arrive in process, typed by Claude Code's own
// declarations, so the core takes them as plain types; nothing is decoded.

// One response's usage as Claude Code's turn.step reports it.
export interface ClaudeUsage {
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cache_read_input_tokens?: number | null | undefined
  readonly cache_creation_input_tokens?: number | null | undefined
  readonly model?: string | undefined
}

export type ClaudeHostEvent =
  | { readonly type: "message_start" }
  | {
    readonly type: "message_end"
    readonly stopReason: string | null
    readonly usage: ClaudeUsage | null
  }
  | { readonly type: "tool_start"; readonly toolName: string; readonly args: unknown }
  | {
    readonly type: "tool_end"
    readonly toolName: string
    readonly isError: boolean
    readonly detail?: string | undefined
  }

export interface ClaudeTurnEnding {
  readonly reason: "answer" | "aborted" | "refusal" | "error"
  readonly detail?: string | undefined
}

export type EmitAnswer =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string }

// Claude's stop reasons, mapped onto Pi's vocabulary that invoke.ts reads.
// A `refusal` ends the invocation as an error. `compaction` cannot arrive:
// the API answers it only to a request asking to pause after compaction,
// which Claude Code 2.1.295 never sends.
const stopReasonOf = (claude: string | null): StopReason => {
  switch (claude) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn": {
      return "stop"
    }
    case "tool_use": {
      return "toolUse"
    }
    case "max_tokens":
    case "model_context_window_exceeded": {
      return "length"
    }
    default: {
      return "error"
    }
  }
}

const ZERO_USAGE: UsageRow = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cost: { total: 0 },
}

// $/Mtok for one Claude model, as Pi's Anthropic catalog spells it.
export interface ClaudeModelCost {
  readonly input: number
  readonly output: number
  readonly cacheRead: number
  readonly cacheWrite: number
}

export type ClaudePrice = (model: string) => ((usage: ClaudeUsage) => number) | undefined

// Notional API-equivalent price: Claude Code reports token counts, never a
// cost. A dated model id falls back to its undated catalog entry. Cost only
// feeds debugging, so a model with no entry counts its tokens at $0 and the
// run.log names it once.
export const claudePrice = (
  lookup: (model: string) => ClaudeModelCost | undefined,
): ClaudePrice => (model) => {
  const entry = lookup(model) ?? lookup(model.replace(/-\d{8}$/, ""))
  if (entry === undefined) return undefined
  return (usage) =>
    (usage.input_tokens * entry.input +
      usage.output_tokens * entry.output +
      (usage.cache_read_input_tokens ?? 0) * entry.cacheRead +
      (usage.cache_creation_input_tokens ?? 0) * entry.cacheWrite) /
    1_000_000
}

interface Invocation {
  readonly id: string
  readonly config: SessionConfig
  readonly listeners: Set<(event: HarnessEvent) => void>
  readonly usageRows: Array<UsageRow>
  readonly transcript: Array<unknown>
  // The opening fiber's services, so a report can write to its run.log.
  readonly services: Context.Context<never>
  turns: number
  started: boolean
  // How the prompt's last response stopped, in Pi's words.
  lastStop: StopReason | undefined
  abortRequested: boolean
  opened: ((error: string | undefined) => void) | undefined
  settle: (() => void) | undefined
  // An abort settles once Claude Code reports the stopped turn, by when
  // its responses have reported what they spent.
  abortSettled: (() => void) | undefined
}

export interface ClaudeHost {
  readonly factory: HarnessSessionFactoryContract
  // Each report answers false when the invocation is unknown (disposed, or
  // never opened by this host).
  readonly opened: (id: string, error: string | undefined) => boolean
  readonly event: (id: string, event: ClaudeHostEvent) => boolean
  readonly emit: (id: string, args: Schema.Json) => EmitAnswer | undefined
  readonly ended: (id: string, ending: ClaudeTurnEnding) => boolean
}

export const makeClaudeHost = (
  price: ClaudePrice,
  send: (command: ClaudeHostCommand) => void,
): ClaudeHost => {
  const invocations = new Map<string, Invocation>()
  const unpriced = new Set<string>()
  let sequence = 0

  const dispatch = (invocation: Invocation, event: HarnessEvent) => {
    invocation.transcript.push(event)
    for (const listener of invocation.listeners) listener(event)
  }

  // Claude Code reports no stream start: the turn's first report is its
  // liveness signal, once per prompt.
  const markStarted = (invocation: Invocation) => {
    if (invocation.started) return
    invocation.started = true
    dispatch(invocation, { type: "message_start" })
  }

  const usageRowOf = (invocation: Invocation, usage: ClaudeUsage): UsageRow => {
    const model = usage.model ?? ""
    const cost = price(model)
    if (cost === undefined && !unpriced.has(model)) {
      unpriced.add(model)
      Effect.runSyncWith(invocation.services)(
        Effect.logWarning(`no price for Claude model ${model}; its tokens count at $0`),
      )
    }
    return {
      input: usage.input_tokens,
      output: usage.output_tokens,
      cacheRead: usage.cache_read_input_tokens ?? 0,
      cacheWrite: usage.cache_creation_input_tokens ?? 0,
      cost: { total: cost?.(usage) ?? 0 },
    }
  }

  const sessionOf = (invocation: Invocation): HarnessSession => ({
    subscribe: (listener) => {
      invocation.listeners.add(listener)
      return () => {
        invocation.listeners.delete(listener)
      }
    },
    prompt: (text) =>
      // @effect-diagnostics-next-line newPromise:off
      new Promise<void>((resolve) => {
        invocation.settle = resolve
        invocation.started = false
        invocation.lastStop = undefined
        const turn = invocation.turns
        invocation.turns += 1
        send({ kind: "prompt", id: invocation.id, text, turn })
      }),
    abort: () =>
      // @effect-diagnostics-next-line newPromise:off
      new Promise<void>((resolve) => {
        invocation.abortRequested = true
        if (invocation.settle === undefined) resolve()
        else invocation.abortSettled = resolve
        send({ kind: "abort", id: invocation.id })
      }),
    dispose: () => {
      invocations.delete(invocation.id)
      send({ kind: "dispose", id: invocation.id })
    },
    usageRows: () => invocation.usageRows,
    transcriptEntries: () => invocation.transcript,
  })

  const event = (id: string, reported: ClaudeHostEvent) => {
    const invocation = invocations.get(id)
    if (invocation === undefined) return false
    markStarted(invocation)
    switch (reported.type) {
      case "message_start": {
        break
      }
      case "message_end": {
        // No response arrived (a failed or interrupted request): the turn's
        // ending carries the terminal evidence instead.
        if (reported.stopReason === null) break
        const row = reported.usage === null ? ZERO_USAGE : usageRowOf(invocation, reported.usage)
        invocation.usageRows.push(row)
        const stopReason = stopReasonOf(reported.stopReason)
        invocation.lastStop = stopReason
        dispatch(
          invocation,
          stopReason === "error"
            ? { type: "message_end", stopReason, usage: row, errorMessage: `Claude stop reason ${reported.stopReason}` }
            : { type: "message_end", stopReason, usage: row },
        )
        break
      }
      case "tool_start": {
        dispatch(invocation, {
          type: "tool_execution_start",
          toolName: reported.toolName,
          args: reported.args,
        })
        break
      }
      case "tool_end": {
        dispatch(
          invocation,
          reported.detail === undefined
            ? { type: "tool_execution_end", toolName: reported.toolName, isError: reported.isError }
            : { type: "tool_execution_end", toolName: reported.toolName, isError: reported.isError, detail: reported.detail },
        )
        break
      }
    }
    return true
  }

  // Claude Code does not enforce a registered tool's schema, so the strict
  // OutputContract decode answers here, and only a decoded call executes.
  const emit = (id: string, args: Schema.Json): EmitAnswer | undefined => {
    const invocation = invocations.get(id)
    if (invocation === undefined) return undefined
    markStarted(invocation)
    const toolName = invocation.config.emitTool.name
    dispatch(invocation, { type: "tool_execution_start", toolName, args })
    const rejection = invocation.config.emitTool.check(args)
    if (rejection !== undefined) {
      dispatch(invocation, { type: "tool_execution_end", toolName, isError: true, detail: rejection })
      return { ok: false, reason: rejection }
    }
    invocation.config.emitTool.execute(args)
    dispatch(invocation, { type: "tool_execution_end", toolName, isError: false })
    return { ok: true }
  }

  // Each response reported its own usage, so an ending carries none. An
  // error or refusal ending is terminal evidence only when the turn's last
  // response did not already end it: Claude Code ends a turn as an error
  // after max_tokens responses it gave up retrying (measured on 2.1.295), and
  // a refusal after the response that stopped on `refusal`. Any other ending
  // of a prompt that recorded no response (a lost record) is an error too, so
  // the invocation fails alone rather than settling with no evidence.
  const ended = (id: string, { detail, reason }: ClaudeTurnEnding) => {
    const invocation = invocations.get(id)
    if (invocation === undefined) return false
    markStarted(invocation)
    const endedByResponse = invocation.lastStop === "length" || invocation.lastStop === "error"
    const failed = (errorMessage: string) => {
      invocation.usageRows.push(ZERO_USAGE)
      dispatch(invocation, { type: "message_end", stopReason: "error", usage: ZERO_USAGE, errorMessage })
    }
    if ((reason === "error" || reason === "refusal") && !endedByResponse) {
      failed(detail ?? `Claude turn ended: ${reason}`)
    } else if (reason === "answer" && invocation.lastStop === undefined) {
      failed("Claude Code turn ended with no recorded response")
    } else if (reason === "aborted" && !invocation.abortRequested) {
      // The run did not ask for this stop: a person stopped the subagent.
      dispatch(invocation, { type: "interrupted", reason: "the Claude Code subagent was stopped outside the run" })
    }
    const settle = invocation.settle
    invocation.settle = undefined
    settle?.()
    const abortSettled = invocation.abortSettled
    invocation.abortSettled = undefined
    abortSettled?.()
    return true
  }

  const opened = (id: string, error: string | undefined) => {
    const pending = invocations.get(id)?.opened
    if (pending === undefined) return false
    pending(error)
    return true
  }

  const open = (config: SessionConfig) =>
    Effect.flatMap(Effect.context<never>(), (services) =>
    Effect.callback<HarnessSession, InvocationSetupError>((resume) => {
      sequence += 1
      const invocation: Invocation = {
        id: `${config.invocationId}#${String(sequence)}`,
        config,
        listeners: new Set(),
        usageRows: [],
        transcript: [],
        services,
        turns: 0,
        started: false,
        lastStop: undefined,
        abortRequested: false,
        opened: undefined,
        settle: undefined,
        abortSettled: undefined,
      }
      invocation.opened = (error) => {
        invocation.opened = undefined
        resume(
          error === undefined
            ? Effect.succeed(sessionOf(invocation))
            : Effect.fail(new InvocationSetupError({ operation: "open", reason: error })),
        )
      }
      invocations.set(invocation.id, invocation)
      send({
        kind: "open",
        id: invocation.id,
        invocationId: config.invocationId,
        seat: config.seat,
        cwd: config.cwd,
        systemPrompt: config.systemPrompt,
        emitTool: {
          name: config.emitTool.name,
          description: config.emitTool.description,
          parameters: config.emitTool.parameters,
        },
        tools: config.tools,
      })
      return Effect.sync(() => {
        if (invocation.opened === undefined) return
        invocation.opened = undefined
        invocations.delete(invocation.id)
        send({ kind: "dispose", id: invocation.id })
      })
    }))

  return {
    // Claude Code's own filesystem tools see the snapshot path itself.
    factory: {
      open,
      workspaceRoot: (snapshot: string) => snapshot,
      workspacePrompt: "workspace-claude-code.md",
      // gauntlet-tools serves each emit tool under the contract's own name.
      emitToolName: (toolName: string) => toolName,
    },
    opened,
    event,
    emit,
    ended,
  }
}
