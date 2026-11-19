import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import type * as Schema from "effect/Schema"
import type { AgentToolCalls } from "../domain/agent-outcome.ts"
import {
  AdapterContractViolation,
  type AgentSpec,
  HarnessSessionFactory,
  type HarnessSessionFactoryContract,
  InvocationSetupError,
  TurnEnd,
  type TurnResult,
  type UsageRow,
} from "./harness-session.ts"

// The scripted Host: each opened session plays a script of turns. A turn
// tries its emits in order against the session's strict decoder, as the live
// Host's emit tool does; the first that passes ends the turn, and each
// rejected one is a diagnostic.

export type ScriptedEnding =
  | { readonly _tag: "Stopped" }
  | { readonly _tag: "ContextLimit" }
  | { readonly _tag: "ProviderFailed"; readonly reason: string }
  | { readonly _tag: "Interrupted"; readonly reason: string }
  // The turn never ends: only the deadline or an interruption stops it.
  | { readonly _tag: "Hangs" }

export interface ScriptedTurn {
  readonly afterMillis?: number
  readonly emits?: ReadonlyArray<unknown>
  // How the turn ends when none of its emits passes; Stopped by default.
  readonly ending?: ScriptedEnding
  readonly usage?: ReadonlyArray<UsageRow>
  readonly toolCalls?: AgentToolCalls
}

export interface ScriptedSession {
  // Claimed by the first open whose invocationId contains this key, so a
  // script can address one invocation of a concurrent fan-out. Unkeyed
  // sessions are claimed in open order.
  readonly forSession?: string
  readonly failOpen?: string
  // When, after its first turn starts, the session streams its first token;
  // "never" withholds it.
  readonly firstTokenAfterMillis?: number | "never"
  readonly turns: ReadonlyArray<ScriptedTurn>
}

export interface ScriptedBehavior {
  readonly sessions: ReadonlyArray<ScriptedSession>
}

export interface RecordedPrompt {
  // 1-based open order, pairing the prompt with specs[openIndex - 1].
  readonly openIndex: number
  readonly invocationId: string
  readonly cacheGroup: string | undefined
  readonly text: string
}

export interface Scripted {
  readonly factory: HarnessSessionFactoryContract
  readonly log: Array<string>
  readonly specs: Array<AgentSpec>
  readonly prompts: Array<RecordedPrompt>
  // Completes once the nth session (1-based) has opened.
  readonly opened: (count: number) => Effect.Effect<void>
}

export const usageRow = (partial?: Partial<UsageRow>): UsageRow => ({
  input: 1000,
  output: 200,
  reasoning: 50,
  cacheRead: 800,
  cacheWrite: 100,
  ...partial,
})

const STOPPED: ScriptedEnding = { _tag: "Stopped" }

const endingOf = (ending: ScriptedEnding): TurnEnd | undefined => {
  switch (ending._tag) {
    case "Stopped":
      return TurnEnd.Stopped()
    case "ContextLimit":
      return TurnEnd.ContextLimit()
    case "ProviderFailed":
      return TurnEnd.ProviderFailed({ reason: ending.reason })
    case "Interrupted":
      return TurnEnd.Interrupted({ reason: ending.reason })
    case "Hangs":
      return undefined
  }
}

export const makeScripted = (behavior: ScriptedBehavior): Scripted => {
  const log: Array<string> = []
  const specs: Array<AgentSpec> = []
  const prompts: Array<RecordedPrompt> = []
  const claimed = new Set<number>()
  const opens: Array<Deferred.Deferred<void>> = []
  const openSignal = (count: number) => {
    const existing = opens[count]
    if (existing !== undefined) return existing
    const created = Deferred.makeUnsafe<void>()
    opens[count] = created
    return created
  }

  const claimSession = (invocationId: string): ScriptedSession | undefined => {
    let unkeyed: number | undefined
    for (const [index, session] of behavior.sessions.entries()) {
      if (claimed.has(index)) continue
      if (session.forSession === undefined) {
        unkeyed = unkeyed ?? index
        continue
      }
      if (invocationId.includes(session.forSession)) {
        claimed.add(index)
        return session
      }
    }
    if (unkeyed === undefined) return undefined
    claimed.add(unkeyed)
    return behavior.sessions[unkeyed]
  }

  const open: HarnessSessionFactoryContract["open"] = (spec) =>
    Effect.gen(function* () {
      specs.push(spec)
      const openIndex = specs.length
      log.push(`open:${String(openIndex)}`)
      yield* Deferred.succeed(openSignal(openIndex), undefined)
      const script = claimSession(spec.invocationId)
      if (script === undefined) {
        return yield* InvocationSetupError.make({ reason: `no scripted session for open ${String(openIndex)}` })
      }
      if (script.failOpen !== undefined) {
        return yield* InvocationSetupError.make({ reason: script.failOpen })
      }
      yield* Effect.addFinalizer(() => Effect.sync(() => log.push(`close:${String(openIndex)}`)))
      const scope = yield* Effect.scope
      const firstToken = yield* Deferred.make<void>()
      let turnIndex = 0

      const playTurn = (turn: ScriptedTurn) =>
        Effect.gen(function* () {
          yield* Effect.sleep(Duration.millis(turn.afterMillis ?? 0))
          const diagnostics: Array<string> = []
          let emitted: Schema.Json | undefined
          for (const raw of turn.emits ?? []) {
            // SAFETY: scripts stand in for model-authored JSON arguments.
            const json = raw as Schema.Json
            const rejection = spec.emit.check(json)
            if (rejection === undefined) {
              emitted = json
              break
            }
            diagnostics.push(`${spec.emit.name} rejected: ${rejection}`)
          }
          const end = emitted === undefined ? endingOf(turn.ending ?? STOPPED) : TurnEnd.Emitted({ raw: emitted })
          if (end === undefined) return yield* Effect.never
          return {
            end,
            usage: turn.usage ?? [usageRow()],
            toolCalls: turn.toolCalls ?? { total: 0, errored: 0 },
            diagnostics,
          } satisfies TurnResult
        })

      return {
        firstToken: Deferred.await(firstToken),
        turn: (text) =>
          Effect.gen(function* () {
            turnIndex += 1
            prompts.push({ openIndex, invocationId: spec.invocationId, cacheGroup: spec.cacheGroup, text })
            log.push(`turn:${String(openIndex)}.${String(turnIndex)}`)
            const turn = script.turns[turnIndex - 1]
            if (turn === undefined) {
              return yield* AdapterContractViolation.make({
                reason: `no scripted turn ${String(turnIndex)} for open ${String(openIndex)}`,
              })
            }
            if (turnIndex === 1 && script.firstTokenAfterMillis !== "never") {
              yield* Effect.sleep(Duration.millis(script.firstTokenAfterMillis ?? 0)).pipe(
                Effect.andThen(Deferred.succeed(firstToken, undefined)),
                Effect.forkIn(scope),
              )
            }
            return yield* playTurn(turn)
          }),
      }
    })

  return {
    factory: { open },
    log,
    specs,
    prompts,
    opened: (count) => Deferred.await(openSignal(count)),
  }
}

export const scriptedLayer = (scripted: Scripted): Layer.Layer<HarnessSessionFactory> =>
  Layer.succeed(HarnessSessionFactory, scripted.factory)
