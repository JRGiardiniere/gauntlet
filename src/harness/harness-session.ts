import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { AgentToolCalls } from "../domain/agent-outcome.ts"
import type { Seat } from "../domain/recipe.ts"

// The seam between an AgentInvocation and the Host that runs it: one session
// per invocation, driven one turn at a time. The live layer drives an
// embedded OpenCode session (src/host/); the scripted layer replays a script
// of turns for tests. Everything about corrective turns, the deadline and
// outcomes lives above it, in invoke.ts.

const usageNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

// One model request's usage, as the Host recorded it. `output` includes
// `reasoning`; `input` excludes cached tokens, so `cacheRead` and
// `cacheWrite` add to it for the whole prompt.
export const UsageRow = Schema.Struct({
  input: usageNumber,
  output: usageNumber,
  reasoning: usageNumber,
  cacheRead: usageNumber,
  cacheWrite: usageNumber,
})

export type UsageRow = typeof UsageRow.Type

// How one turn ended.
export type TurnEnd = Data.TaggedEnum<{
  // A validated emit landed; the Host sent no further model request.
  Emitted: { readonly raw: Schema.Json }
  // The model ended its turn without a valid emit.
  Stopped: {}
  ContextLimit: {}
  ProviderFailed: { readonly reason: string }
  // Something outside the Run stopped the session.
  Interrupted: { readonly reason: string }
}>

export const TurnEnd = Data.taggedEnum<TurnEnd>()

export interface TurnResult {
  readonly end: TurnEnd
  // One row per model request the turn made, read once when it ended.
  readonly usage: ReadonlyArray<UsageRow>
  // Inspection tool calls; emit calls are not counted.
  readonly toolCalls: AgentToolCalls
  // Emits the strict decoder rejected (they went back to the model as tool
  // errors), and anything else the Host noticed.
  readonly diagnostics: ReadonlyArray<string>
}

export const INSPECTION_TOOLS = ["read", "grep", "glob"] as const

export type InspectionTool = (typeof INSPECTION_TOOLS)[number]

// The emit tool as the Host registers it: the contract's JSON Schema
// projection, and the strict decoder, which answers a rejection reason or
// undefined when the arguments decode.
export interface EmitToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema.JsonSchema
  readonly check: (raw: Schema.Json) => string | undefined
}

export interface AgentSpec {
  // Names the invocation in diagnostics and scripts.
  readonly invocationId: string
  // The Stage role this invocation plays in its Run (`finder-1`, `pool`…).
  // Invocations sharing a role share one Host agent, so they must share the
  // system prompt, tools and emit tool.
  readonly role: string
  readonly seat: Seat
  // The Run's frozen snapshot, the root every inspection tool sees.
  readonly workspace: string
  readonly systemPrompt: string
  readonly tools: ReadonlyArray<InspectionTool>
  readonly emit: EmitToolSpec
  // Finders in one partition share it, so the Host sends them one provider
  // cache key.
  readonly cacheGroup?: string
}

export interface HarnessSession {
  readonly turn: (text: string) => Effect.Effect<TurnResult, AdapterContractViolation>
  // Completes when the session's first model response streams its first token.
  readonly firstToken: Effect.Effect<void>
  // Stops the session and returns the usage of steps no turn has returned:
  // what the turn a deadline cut short had already spent.
  readonly cutShort: Effect.Effect<ReadonlyArray<UsageRow>>
}

// "No outcome can exist": the session could not be opened or prompted.
export class InvocationSetupError extends Schema.TaggedError<
  InvocationSetupError,
  { readonly brand: unique symbol }
>()("InvocationSetupError", {
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

// "No outcome can exist": the Host broke its contract, e.g. a turn ended
// with no assistant message, or a validated emit failed the decoder.
export class AdapterContractViolation extends Schema.TaggedError<
  AdapterContractViolation,
  { readonly brand: unique symbol }
>()("AdapterContractViolation", {
  reason: Schema.String,
}) {}

export type InvocationFailure =
  | InvocationSetupError
  | AdapterContractViolation

export interface HarnessSessionFactoryContract {
  // The session lives until the scope closes; closing it stops and removes
  // the Host's session.
  readonly open: (spec: AgentSpec) => Effect.Effect<HarnessSession, InvocationSetupError, Scope.Scope>
}

export class HarnessSessionFactory extends Context.Service<
  HarnessSessionFactory,
  HarnessSessionFactoryContract
>()("gauntlet/HarnessSessionFactory") {}
