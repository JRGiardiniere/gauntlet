import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import {
  type HarnessEvent,
  type HarnessSession,
  type RawUsage,
  type SessionConfig,
  type HarnessSessionFactoryShape,
  SessionOpenError,
  type StopReason,
} from "./harness-session.ts"

// The deterministic scripted adapter — the test layer of the seam.
//
// The session object is PLAIN JavaScript with the exact Promise/callback
// surface the live Pi session has (harness-session.ts), so code under test
// exercises the real bridge. Only the script driver is Effect: a fiber forked
// into the opening scope that sleeps on the (Test)Clock and fires the push
// callbacks — which is what makes event timing controllable from
// TestClock.adjust and guarantees the driver dies when the scope closes.

export type ScriptedEvent =
  | { readonly afterMillis: number; readonly kind: "message_start" }
  | {
      readonly afterMillis: number
      readonly kind: "message_end"
      readonly stopReason: StopReason
      readonly errorMessage?: string
      readonly usage?: RawUsage
    }
  // Fires tool_execution_start with the raw args; when `valid`, also calls
  // the emit tool's execute (Pi calls execute only after validation passes).
  | {
      readonly afterMillis: number
      readonly kind: "emit"
      readonly args: unknown
      readonly valid: boolean
    }
  // What the live adapter fires when a Pi event no longer decodes.
  | {
      readonly afterMillis: number
      readonly kind: "violation"
      readonly reason: string
    }

export interface ScriptedBehavior {
  readonly openDelayMillis?: number
  readonly failOpen?: string
  readonly events: ReadonlyArray<ScriptedEvent>
  readonly promptSettles: "after-events" | "never"
  readonly abortBehavior?: "resolves" | "hangs"
  // Overrides the sweep with arbitrary rows — the drifted-usage-shape path.
  // When absent, the sweep returns the usage rows of the scripted
  // message_end events, as Pi's terminal sweep over session.messages would.
  readonly sweptUsageRows?: ReadonlyArray<unknown>
  readonly failUsageSweep?: string
}

export interface Scripted {
  readonly factory: HarnessSessionFactoryShape
  // Ordered call log for cleanup/ordering assertions:
  // open, subscribe, prompt, event:<kind>, abort, unsubscribe, usage-read,
  // dispose.
  readonly log: Array<string>
}

export const usageRow = (partial?: Partial<RawUsage>): RawUsage => ({
  input: 1000,
  output: 200,
  cacheRead: 800,
  cacheWrite: 100,
  reasoning: 50,
  cost: { total: 0.05 },
  ...partial,
})

export const makeScripted = (behavior: ScriptedBehavior): Scripted => {
  const log: Array<string> = []

  const open = (config: SessionConfig) =>
    Effect.gen(function* () {
      log.push("open")
      if (behavior.failOpen !== undefined) {
        return yield* new SessionOpenError({ reason: behavior.failOpen })
      }
      if (behavior.openDelayMillis !== undefined) {
        yield* Effect.sleep(Duration.millis(behavior.openDelayMillis))
      }

      const listeners = new Set<(event: HarnessEvent) => void>()
      const rows: Array<unknown> = []
      let promptStarted: (() => void) | undefined
      let promptSettled: (() => void) | undefined
      const promptStartedPromise = new Promise<void>((resolve) => {
        promptStarted = resolve
      })

      const fire = (event: HarnessEvent) => {
        for (const listener of listeners) listener(event)
      }

      const drive = Effect.gen(function* () {
        yield* Effect.promise(() => promptStartedPromise)
        let elapsed = 0
        for (const step of behavior.events) {
          if (step.afterMillis > elapsed) {
            yield* Effect.sleep(Duration.millis(step.afterMillis - elapsed))
            elapsed = step.afterMillis
          }
          yield* Effect.sync(() => {
            log.push(`event:${step.kind}`)
            switch (step.kind) {
              case "message_start": {
                fire({ type: "message_start" })
                break
              }
              case "message_end": {
                // Pi reports usage on every assistant message; the sweep and
                // the event stay consistent, defaulted or scripted.
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
              case "violation": {
                fire({ type: "contract_violation", reason: step.reason })
                break
              }
            }
          })
        }
        if (behavior.promptSettles === "after-events") {
          yield* Effect.sync(() => promptSettled?.())
        }
      })
      yield* Effect.forkScoped(drive)

      const session: HarnessSession = {
        subscribe: (listener) => {
          log.push("subscribe")
          listeners.add(listener)
          return () => {
            log.push("unsubscribe")
            listeners.delete(listener)
          }
        },
        prompt: () => {
          log.push("prompt")
          return new Promise<void>((resolve) => {
            promptSettled = resolve
            promptStarted?.()
          })
        },
        abort: () => {
          log.push("abort")
          return behavior.abortBehavior === "hangs"
            ? new Promise<never>(() => undefined)
            : Promise.resolve()
        },
        dispose: () => {
          log.push("dispose")
        },
        usageRows: () => {
          log.push("usage-read")
          if (behavior.failUsageSweep !== undefined) {
            // A real sweep failure is plain-JS breakage (reading through a
            // renamed SDK field), so the simulation throws the same way.
            throw new TypeError(behavior.failUsageSweep)
          }
          return behavior.sweptUsageRows ?? rows
        },
      }
      return session
    })

  return { factory: { open }, log }
}
