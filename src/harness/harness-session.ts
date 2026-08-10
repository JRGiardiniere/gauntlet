import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"

// The adapter seam between Gauntlet and the Pi harness (ADR 0002, #4, #13).
// `HarnessSession` deliberately mirrors Pi's literal surface — push-callback
// subscribe returning an unsubscribe thunk, a Promise `prompt` that resolves
// at end-of-run, an `abort` that may hang forever, a synchronous `dispose`,
// and a usage sweep that must precede dispose — so the live adapter stays a
// pure mapping and the scripted adapter implements the identical shape. The
// bridge under test is the bridge that ships.

// Pi's full stop-reason vocabulary, mirrored exactly. Anything outside this
// set is contract drift, never coerced to a plausible default.
export const StopReason = Schema.Literals([
  "pending",
  "stop",
  "length",
  "toolUse",
  "error",
  "aborted",
  "deferred",
])
export type StopReason = typeof StopReason.Type

const usageNumber = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))

// The subset of Pi's per-turn Usage that accounting reads, decoded at the
// boundary. A drifted shape silently reads as $0 and looks healthy — the
// demonstrated hazard (#4 §8) — so every field must decode finite and
// non-negative. `reasoning` is a subset of `output` (never summed in) and is
// genuinely absent for many providers.
export const RawUsage = Schema.Struct({
  input: usageNumber,
  output: usageNumber,
  cacheRead: usageNumber,
  cacheWrite: usageNumber,
  // Genuinely absent for many providers — and possibly present-but-undefined
  // on Pi's in-memory rows, which is not a JSON boundary.
  reasoning: Schema.optional(usageNumber),
  cost: Schema.Struct({ total: usageNumber }),
})
export type RawUsage = typeof RawUsage.Type

// The three events production consumes (#4 §3) — liveness, terminal message
// state, and raw pre-validation tool args (the salvage path) — plus the
// channel an adapter uses to report its own boundary-decode failures.
// Listeners are called synchronously, so a `contract_violation` can never
// lose a race with the events it poisons.
export type HarnessEvent =
  | { readonly type: "message_start" }
  | {
      readonly type: "message_end"
      readonly stopReason: StopReason
      readonly errorMessage?: string
      readonly usage: RawUsage
    }
  | {
      readonly type: "tool_execution_start"
      readonly toolName: string
      readonly args: unknown
    }
  | { readonly type: "contract_violation"; readonly reason: string }

export interface HarnessSession {
  readonly subscribe: (listener: (event: HarnessEvent) => void) => () => void
  readonly prompt: (text: string) => Promise<void>
  // May never settle: Pi's abort awaits waitForIdle (#4 §4). Fire-and-forget
  // always — Gauntlet never re-prompts an aborted session (stall retry is a
  // fresh invocation; corrective turns re-prompt only after a clean stop).
  readonly abort: () => Promise<void>
  readonly dispose: () => void
  // Terminal accounting sweep over the session's assistant messages, raw and
  // verbatim. MUST be called before dispose — dispose disconnects the session
  // from the agent that owns the messages. Rows decode against RawUsage in
  // the bridge; drift fails loudly there.
  readonly usageRows: () => ReadonlyArray<unknown>
}

// The terminating emit tool as the seam sees it: parameters are an already
// projected plain JSON Schema (Pi detects the missing TypeBox.Kind symbol and
// runs its JSON-Schema coercion path, #4 §5), and `execute` is called only
// when the harness validated the arguments — a failed validation surfaces
// only as tool_execution_start.
export interface EmitToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema.JsonSchema
  readonly execute: (args: unknown) => void
}

export interface SessionConfig {
  // Overrides Pi's stock system prompt. Must be non-empty: Pi treats an empty
  // string as "use the stock prompt" (#4 §2).
  readonly systemPrompt: string
  // The provider prompt-cache partition key (#4 §6). Absent means Pi mints a
  // fresh id; fan-outs that want cache sharing pass one shared key per model
  // group.
  readonly sessionId?: string
  readonly emitTool: EmitToolSpec
}

// "No outcome can exist" — session construction failed (CONTEXT.md: Failure).
export class SessionOpenError extends Data.TaggedError("SessionOpenError")<{
  readonly reason: string
}> {}

// "No outcome can exist" — the adapter broke its contract: a drifted usage
// shape, an event that no longer decodes. Raised even when an emit was
// captured, because a silently-$0 invocation is indistinguishable from a
// healthy one (ADR 0001, #4 §8).
export class AdapterContractViolation extends Data.TaggedError(
  "AdapterContractViolation",
)<{ readonly reason: string }> {}

export interface HarnessSessionFactoryShape {
  // `open` may do blocking work (credential/catalog reads); callers bound it
  // separately from the run budget. Interruptibility of the acquire is the
  // bridge's job (session-bridge.ts).
  readonly open: (
    config: SessionConfig,
  ) => Effect.Effect<HarnessSession, SessionOpenError, Scope.Scope>
}

// The single primary testing seam. Live layer: pi-live.ts. Test layer: the
// scripted adapter (scripted.ts) — behavior-parameterized, so it plays the
// role a static Fake would.
export class HarnessSessionFactory extends Context.Service<
  HarnessSessionFactory,
  HarnessSessionFactoryShape
>()("gauntlet/HarnessSessionFactory") {}
