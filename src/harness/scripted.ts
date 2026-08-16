import type { ReadToolInput, ToolDefinition } from "@earendil-works/pi-coding-agent"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import { type BashArgs, makeReviewWorkspace } from "../workspace/just-bash-workspace.ts"
import type { ReviewWorkspace } from "../workspace/review-workspace.ts"
import {
  type CapturedConversationPrefix,
  type EmitToolArgs,
  type HarnessEvent,
  type HarnessSession,
  HarnessSessionFactory,
  type HarnessSessionFactoryContract,
  InvocationSetupError,
  makeReplayableConversationPrefix,
  type ReplayableConversationPrefix,
  type SessionConfig,
  type StopReason,
  type UsageRow,
} from "./harness-session.ts"
import { withToolCallDeadline } from "./tool-deadline.ts"

// The deterministic adapter supports a script per open and per prompt. A
// fresh-session retry therefore consumes the next session script, while a
// corrective turn consumes the next prompt on the same session.

export type ScriptedEvent =
  | { readonly afterMillis: number; readonly kind: "message_start" }
  | {
      readonly afterMillis: number
      readonly kind: "message_end"
      readonly stopReason: StopReason
      readonly errorMessage?: string
      readonly usage?: UsageRow
    }
  | {
      readonly afterMillis: number
      readonly kind: "emit"
      readonly args: unknown
      readonly valid: false
    }
  | {
      readonly afterMillis: number
      readonly kind: "emit"
      readonly args: EmitToolArgs
      readonly valid: true
    }
  | {
      readonly afterMillis: number
      readonly kind: "tool"
      readonly toolName: "read"
      readonly args: ReadToolInput
    }
  | {
      readonly afterMillis: number
      readonly kind: "tool"
      readonly toolName: "bash"
      readonly args: BashArgs
    }
  | {
      readonly afterMillis: number
      readonly kind: "tool_error"
      readonly toolName: string
      readonly detail: string
    }
  | {
      readonly afterMillis: number
      readonly kind: "violation"
      readonly reason: string
    }

export interface ScriptedPrompt {
  readonly events: ReadonlyArray<ScriptedEvent>
  readonly settles: "after-events" | "never"
  readonly reject?: string
  readonly assistantText?: string
}

export interface ScriptedSession {
  // Claimed by the first open whose config.cacheGroupId contains this key —
  // lets a script address one invocation of a concurrent fan-out. Unkeyed
  // sessions are consumed in open order, as before.
  readonly forSession?: string
  readonly openDelayMillis?: number
  readonly failOpen?: string
  readonly prompts: ReadonlyArray<ScriptedPrompt>
  readonly abortBehavior?: "resolves" | "hangs"
  readonly sweptUsageRows?: ReadonlyArray<unknown>
  readonly failUsageSweep?: string
  readonly failDispose?: string
}

export interface ScriptedBehavior {
  readonly sessions: ReadonlyArray<ScriptedSession>
}

export interface RecordedPrompt {
  // 1-based open order — pairs the prompt with configs[openIndex - 1] even
  // when concurrent sessions interleave their prompt calls.
  readonly openIndex: number
  readonly cacheGroupId: string | undefined
  readonly text: string
}

export interface RecordedInspection {
  readonly cacheGroupId: string | undefined
  readonly toolName: "read" | "bash"
  readonly args: unknown
  readonly isError: boolean
  readonly text: string
}

export interface Scripted {
  readonly factory: HarnessSessionFactoryContract
  readonly log: Array<string>
  readonly configs: Array<SessionConfig>
  readonly prompts: Array<RecordedPrompt>
  readonly inspections: Array<RecordedInspection>
  readonly prefixes: Array<RecordedConversationPrefix>
}

export interface RecordedConversationPrefix {
  readonly prefix: ReplayableConversationPrefix
  readonly userPrompt: string
  readonly assistantText: string
}

const toolText = (result: {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text?: string }>
}): string =>
  result.content
    .flatMap((entry) =>
      entry.type === "text" && entry.text !== undefined ? [entry.text] : [],
    )
    .join("\n")

const scriptInspectsWorkspace = (session: ScriptedSession): boolean =>
  session.prompts.some((prompt) =>
    prompt.events.some((event) => event.kind === "tool"),
  )

export const usageRow = (partial?: Partial<UsageRow>): UsageRow => ({
  input: 1000,
  output: 200,
  cacheRead: 800,
  cacheWrite: 100,
  reasoning: 50,
  cost: { total: 0.05 },
  ...partial,
})

interface PromptRequest {
  readonly text: string
  readonly resolve: () => void
  readonly reject: (reason: string) => void
}

// A workspace tool call as the script declares it. The scripted adapter
// trusts its statically-typed script input: it hands each tool event's args
// straight to the selected tool's execute function without replaying Pi's
// schema validation (a script is test-authored input, not live model output).
type WorkspaceToolCall = Extract<ScriptedEvent, { readonly kind: "tool" }>

const executeWorkspaceTool = (
  workspace: ReviewWorkspace,
  config: SessionConfig,
  call: WorkspaceToolCall,
) => {
  const tool: ToolDefinition = call.toolName === "read"
    ? withToolCallDeadline(workspace.readTool, config.toolTimeoutMillis)
    : withToolCallDeadline(workspace.bashTool, config.bashTimeoutMillis)
  // SAFETY: both workspace tools tolerate a missing ExtensionContext — the
  // read tool reads it only through optional chaining (ctx?.model) and the
  // bash tool ignores it — so undefined is a faithful placeholder in a fake
  // that constructs no context.
  return Effect.promise(() =>
    tool
      .execute("scripted", call.args, undefined, undefined, undefined as never)
      .then((result) => ({
        isError: false as const,
        text: toolText(result),
      }))
      .catch((cause: unknown) => ({
        isError: true as const,
        text: cause instanceof Error ? cause.message : String(cause),
      })),
  )
}

export const makeScripted = (behavior: ScriptedBehavior): Scripted => {
  const log: Array<string> = []
  const configs: Array<SessionConfig> = []
  const prompts: Array<RecordedPrompt> = []
  const inspections: Array<RecordedInspection> = []
  const prefixes: Array<RecordedConversationPrefix> = []
  let openIndex = 0
  const claimed = new Set<number>()

  const claimSession = (
    cacheGroupId: string | undefined,
  ): ScriptedSession | undefined => {
    let unkeyed: number | undefined
    for (const [index, session] of behavior.sessions.entries()) {
      if (claimed.has(index)) continue
      if (session.forSession === undefined) {
        unkeyed = unkeyed ?? index
        continue
      }
      if (
        cacheGroupId !== undefined && cacheGroupId.includes(session.forSession)
      ) {
        claimed.add(index)
        return session
      }
    }
    if (unkeyed === undefined) return undefined
    claimed.add(unkeyed)
    return behavior.sessions[unkeyed]
  }

  const open: HarnessSessionFactoryContract["open"] = (config) =>
    Effect.gen(function* () {
      const sessionIndex = openIndex + 1
      const behaviorForSession = claimSession(config.cacheGroupId)
      openIndex += 1
      log.push(`open:${String(sessionIndex)}`)
      configs.push(config)

      if (behaviorForSession === undefined) {
        return yield* new InvocationSetupError({
          operation: "open",
          reason: `no scripted session for open ${String(sessionIndex)}`,
        })
      }
      if (behaviorForSession.failOpen !== undefined) {
        return yield* new InvocationSetupError({
          operation: "open",
          reason: behaviorForSession.failOpen,
        })
      }
      if (
        config.conversationPrefix !== undefined &&
        !prefixes.some(({ prefix }) => prefix === config.conversationPrefix)
      ) {
        return yield* new InvocationSetupError({
          operation: "open",
          reason: "conversation prefix was not captured by this scripted factory",
        })
      }
      if (behaviorForSession.openDelayMillis !== undefined) {
        yield* Effect.sleep(
          Duration.millis(behaviorForSession.openDelayMillis),
        )
      }

      // The live adapter always mounts a ReviewWorkspace for filesystem
      // sessions. This adapter does the same only when a script declares a
      // tool event, so invocation-unit tests with a fake cwd stay cheap.
      const workspace = config.mode === "invocation" &&
          scriptInspectsWorkspace(behaviorForSession)
        ? yield* Effect.tryPromise({
            try: () => makeReviewWorkspace(config.cwd),
            catch: (cause) =>
              new InvocationSetupError({
                operation: "session-construction",
                reason: `failed to construct ReviewWorkspace: ${
                  cause instanceof Error ? cause.message : String(cause)
                }`,
                cause,
              }),
          })
        : undefined

      const listeners = new Set<(event: HarnessEvent) => void>()
      const rows: Array<unknown> = []
      const promptRequests = yield* Queue.unbounded<PromptRequest>()
      let requestedPrompts = 0
      let capturedPrefix: CapturedConversationPrefix | undefined

      const fire = (event: HarnessEvent) => {
        for (const listener of listeners) listener(event)
      }

      const drivePrompt = (
        prompt: ScriptedPrompt,
        promptIndex: number,
        request: PromptRequest,
      ) =>
        Effect.gen(function* () {
          let elapsed = 0
          for (const step of prompt.events) {
            if (step.afterMillis > elapsed) {
              yield* Effect.sleep(Duration.millis(step.afterMillis - elapsed))
              elapsed = step.afterMillis
            }
            yield* Effect.sync(() => {
              log.push(
                `event:${String(sessionIndex)}.${String(promptIndex)}:${step.kind}`,
              )
            })
            switch (step.kind) {
              case "message_start": {
                yield* Effect.sync(() => fire({ type: "message_start" }))
                break
              }
              case "message_end": {
                yield* Effect.sync(() => {
                  const usage = step.usage ?? usageRow()
                  rows.push(usage)
                  const event = {
                    type: "message_end" as const,
                    stopReason: step.stopReason,
                    usage,
                  }
                  fire(
                    step.errorMessage === undefined
                      ? event
                      : { ...event, errorMessage: step.errorMessage },
                  )
                })
                break
              }
              case "emit": {
                yield* Effect.sync(() => {
                  fire({
                    type: "tool_execution_start",
                    toolName: config.emitTool.name,
                    args: step.args,
                  })
                  if (step.valid && config.mode === "invocation") {
                    config.emitTool.execute(step.args)
                  }
                })
                break
              }
              case "tool": {
                yield* Effect.sync(() => {
                  fire({
                    type: "tool_execution_start",
                    toolName: step.toolName,
                    args: step.args,
                  })
                })
                const recorded = config.mode === "preload"
                  ? {
                      isError: true as const,
                      text: "finder preload cannot call workspace tools",
                    }
                  : workspace === undefined ||
                    !config.tools.includes(step.toolName)
                  ? {
                      isError: true as const,
                      text: workspace === undefined
                        ? "no ReviewWorkspace for this session"
                        : `${step.toolName} is not in this session's tools`,
                    }
                  : yield* executeWorkspaceTool(workspace, config, step)
                yield* Effect.sync(() => {
                  inspections.push({
                    cacheGroupId: config.cacheGroupId,
                    toolName: step.toolName,
                    args: step.args,
                    isError: recorded.isError,
                    text: recorded.text,
                  })
                  const event = {
                    type: "tool_execution_end" as const,
                    toolName: step.toolName,
                    isError: recorded.isError,
                  }
                  fire(
                    recorded.isError ? { ...event, detail: recorded.text } : event,
                  )
                })
                break
              }
              case "tool_error": {
                yield* Effect.sync(() => {
                  fire({
                    type: "tool_execution_end",
                    toolName: step.toolName,
                    isError: true,
                    detail: step.detail,
                  })
                })
                break
              }
              case "violation": {
                yield* Effect.sync(() => {
                  fire({ type: "contract_violation", reason: step.reason })
                })
                break
              }
            }
          }

          if (prompt.settles === "never") return yield* Effect.never
          yield* Effect.sync(() => {
            const assistantText = prompt.assistantText
            if (assistantText !== undefined && assistantText.trim() !== "") {
              const prefix = makeReplayableConversationPrefix()
              capturedPrefix = { prefix, assistantText }
              prefixes.push({
                prefix,
                userPrompt: request.text,
                assistantText,
              })
            }
          })
          yield* Effect.sync(() => {
            if (prompt.reject === undefined) request.resolve()
            else request.reject(prompt.reject)
          })
        })

      yield* Effect.forEach(
        behaviorForSession.prompts,
        (prompt, index) =>
          Effect.gen(function* () {
            const request = yield* Queue.take(promptRequests)
            yield* drivePrompt(prompt, index + 1, request)
          }),
        { discard: true },
      ).pipe(Effect.forkScoped)

      const session: HarnessSession = {
        subscribe: (listener) => {
          log.push(`subscribe:${String(sessionIndex)}`)
          listeners.add(listener)
          return () => {
            log.push(`unsubscribe:${String(sessionIndex)}`)
            listeners.delete(listener)
          }
        },
        prompt: (text) => {
          prompts.push({
            openIndex: sessionIndex,
            cacheGroupId: config.cacheGroupId,
            text,
          })
          requestedPrompts += 1
          const promptIndex = requestedPrompts
          log.push(`prompt:${String(sessionIndex)}.${String(promptIndex)}`)
          if (promptIndex > behaviorForSession.prompts.length) {
            return Promise.reject(
              `no scripted prompt ${String(promptIndex)} for session ${String(sessionIndex)}`,
            )
          }
          // @effect-diagnostics-next-line newPromise:off
          return new Promise<void>((resolve, reject) => {
            Queue.offerUnsafe(promptRequests, {
              text,
              resolve,
              reject: (reason) => reject(reason),
            })
          })
        },
        abort: () => {
          log.push(`abort:${String(sessionIndex)}`)
          return behaviorForSession.abortBehavior === "hangs"
            // @effect-diagnostics-next-line newPromise:off
            ? new Promise<never>(() => undefined)
            : Promise.resolve()
        },
        captureConversationPrefix: () => capturedPrefix,
        dispose: () => {
          log.push(`dispose:${String(sessionIndex)}`)
          if (behaviorForSession.failDispose !== undefined) {
            throw new TypeError(behaviorForSession.failDispose)
          }
        },
        usageRows: () => {
          log.push(`usage-read:${String(sessionIndex)}`)
          if (behaviorForSession.failUsageSweep !== undefined) {
            throw new TypeError(behaviorForSession.failUsageSweep)
          }
          return behaviorForSession.sweptUsageRows ?? rows
        },
      }
      return session
    })

  return { factory: { open }, log, configs, prompts, inspections, prefixes }
}

export const scriptedLayer = (
  scripted: Scripted,
): Layer.Layer<HarnessSessionFactory> =>
  Layer.succeed(HarnessSessionFactory, scripted.factory)
