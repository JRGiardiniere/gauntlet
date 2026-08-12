import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import {
  type HarnessEvent,
  type HarnessSession,
  HarnessSessionFactory,
  type HarnessSessionFactoryShape,
  InvocationSetupError,
  type SessionConfig,
  type StopReason,
  type UsageRow,
} from "./harness-session.ts"

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
      readonly valid: boolean
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
}

export interface ScriptedSession {
  // Claimed by the first open whose config.sessionId ends with this suffix —
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

export interface Scripted {
  readonly factory: HarnessSessionFactoryShape
  readonly log: Array<string>
  readonly configs: Array<SessionConfig>
  readonly promptTexts: Array<string>
}

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
  readonly resolve: () => void
  readonly reject: (reason: string) => void
}

export const makeScripted = (behavior: ScriptedBehavior): Scripted => {
  const log: Array<string> = []
  const configs: Array<SessionConfig> = []
  const promptTexts: Array<string> = []
  let openIndex = 0
  const claimed = new Set<number>()

  const claimSession = (
    sessionId: string | undefined,
  ): ScriptedSession | undefined => {
    let unkeyed: number | undefined
    for (const [index, session] of behavior.sessions.entries()) {
      if (claimed.has(index)) continue
      if (session.forSession === undefined) {
        unkeyed = unkeyed ?? index
        continue
      }
      if (sessionId !== undefined && sessionId.endsWith(session.forSession)) {
        claimed.add(index)
        return session
      }
    }
    if (unkeyed === undefined) return undefined
    claimed.add(unkeyed)
    return behavior.sessions[unkeyed]
  }

  const open: HarnessSessionFactoryShape["open"] = (config) =>
    Effect.gen(function* () {
      const sessionIndex = openIndex + 1
      const behaviorForSession = claimSession(config.sessionId)
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
      if (behaviorForSession.openDelayMillis !== undefined) {
        yield* Effect.sleep(
          Duration.millis(behaviorForSession.openDelayMillis),
        )
      }

      const listeners = new Set<(event: HarnessEvent) => void>()
      const rows: Array<unknown> = []
      const promptRequests = yield* Queue.unbounded<PromptRequest>()
      let requestedPrompts = 0

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
              switch (step.kind) {
                case "message_start": {
                  fire({ type: "message_start" })
                  break
                }
                case "message_end": {
                  const usage = step.usage ?? usageRow()
                  rows.push(usage)
                  fire({
                    type: "message_end",
                    stopReason: step.stopReason,
                    ...(step.errorMessage === undefined
                      ? {}
                      : { errorMessage: step.errorMessage }),
                    usage,
                  })
                  break
                }
                case "emit": {
                  fire({
                    type: "tool_execution_start",
                    toolName: config.emitTool.name,
                    args: step.args,
                  })
                  if (step.valid) config.emitTool.execute(step.args)
                  break
                }
                case "tool_error": {
                  fire({
                    type: "tool_execution_end",
                    toolName: step.toolName,
                    isError: true,
                    detail: step.detail,
                  })
                  break
                }
                case "violation": {
                  fire({ type: "contract_violation", reason: step.reason })
                  break
                }
              }
            })
          }

          if (prompt.settles === "never") return yield* Effect.never
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
          promptTexts.push(text)
          requestedPrompts += 1
          const promptIndex = requestedPrompts
          log.push(`prompt:${String(sessionIndex)}.${String(promptIndex)}`)
          if (promptIndex > behaviorForSession.prompts.length) {
            return Promise.reject(
              `no scripted prompt ${String(promptIndex)} for session ${String(sessionIndex)}`,
            )
          }
          return new Promise<void>((resolve, reject) => {
            Queue.offerUnsafe(promptRequests, {
              resolve,
              reject: (reason) => reject(reason),
            })
          })
        },
        abort: () => {
          log.push(`abort:${String(sessionIndex)}`)
          return behaviorForSession.abortBehavior === "hangs"
            ? new Promise<never>(() => undefined)
            : Promise.resolve()
        },
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

  return { factory: { open }, log, configs, promptTexts }
}

export const scriptedLayer = (
  scripted: Scripted,
): Layer.Layer<HarnessSessionFactory> =>
  Layer.succeed(HarnessSessionFactory, scripted.factory)
