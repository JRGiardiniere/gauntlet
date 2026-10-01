import * as Schema from "effect/Schema"

// How an invocation ended — a mode on an AgentOutcome, not a failure
// (CONTEXT.md, ADR 0001). Every expected bad ending is data here; the Effect
// error channel is reserved for "no outcome can exist at all".
export const Termination = Schema.TaggedUnion({
  Completed: {},
  MissingEmit: {
    // Corrective turns spent on the same session before recording this mode.
    correctiveTurns: Schema.Int,
  },
  FirstResponseTimeout: {},
  BudgetExhausted: {},
  ContextLimit: {},
  ProviderFailed: {},
  Interrupted: {},
})
export type Termination = typeof Termination.Type

const usageNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

// Accounting is decoded from Pi's rows, while the JSON-safe serialized rows
// remain available as persistence evidence (ADR 0006). `reasoning` is a
// subset of output and is never added to it.
export const AgentUsage = Schema.Struct({
  input: usageNumber,
  output: usageNumber,
  cacheRead: usageNumber,
  cacheWrite: usageNumber,
  reasoning: usageNumber,
  costUsd: usageNumber,
  rawRows: Schema.Array(Schema.Json),
})
export interface AgentUsage extends Schema.Schema.Type<typeof AgentUsage> {}

// Inspection tool calls the agent made (emit calls excluded — those are the
// output contract, judged elsewhere). `errored` counts calls whose result
// went back to the model marked isError; a dead tool shows as errored ===
// total, which is invisible in findings alone (measured 2026-09-10: three
// weeks of every finder bash call erroring under Bun).
export const AgentToolCalls = Schema.Struct({
  total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  errored: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
})
export interface AgentToolCalls
  extends Schema.Schema.Type<typeof AgentToolCalls> {}

// Everything one AgentInvocation yielded. The schema is a factory because
// the same OutputContract schema owns the stage output here and in the emit
// tool and Finder-stage checkpoint decoder.
export interface AgentOutcome<O> {
  readonly termination: Termination
  readonly output?: O
  readonly usage: AgentUsage
  readonly toolCalls: AgentToolCalls
  readonly durationMillis: number
  readonly diagnostics: ReadonlyArray<string>
}

export const AgentOutcome = <S extends Schema.Top>(output: S) =>
  Schema.Struct({
    termination: Termination,
    output: Schema.optionalKey(output),
    usage: AgentUsage,
    toolCalls: AgentToolCalls,
    durationMillis: usageNumber,
    diagnostics: Schema.Array(Schema.String),
  })
