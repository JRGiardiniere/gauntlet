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

// Everything one AgentInvocation yielded: optional output, a termination
// mode, usage, and diagnostics — all data, even when the invocation ended
// badly (ADR 0001). Output and usage coexist with bad endings by design.
export const AgentOutcome = Schema.Struct({
  termination: Termination,
  // Stage-specific emit payload; decoded strictly by the stage that owns it.
  output: Schema.optionalKey(Schema.Unknown),
  // Raw per-invocation usage verbatim as the harness reports it (ADR 0006).
  // The Pi adapter schema-decodes this at its boundary; drift there fails
  // loudly as an adapter contract violation, never lands here as garbage.
  usage: Schema.optionalKey(Schema.Unknown),
  diagnostics: Schema.Array(Schema.String),
})
export type AgentOutcome = typeof AgentOutcome.Type
