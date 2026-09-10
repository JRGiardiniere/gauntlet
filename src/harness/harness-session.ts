import * as Context from "effect/Context"
import * as Data from "effect/Data"
import type * as Effect from "effect/Effect"
import type * as JsonSchema from "effect/JsonSchema"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import type { Seat } from "../domain/recipe.ts"

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
// genuinely absent for many providers. This is the DECODED accounting subset;
// the untouched `unknown` values retained by the invocation accumulator remain
// available to persisted Finder outcomes and runtime Dossier accounting
// (ADR 0006).
export const UsageRow = Schema.Struct({
  input: usageNumber,
  output: usageNumber,
  cacheRead: usageNumber,
  cacheWrite: usageNumber,
  // Genuinely absent for many providers — and possibly present-but-undefined
  // on Pi's in-memory rows, which is not a JSON boundary.
  reasoning: Schema.optional(usageNumber),
  cost: Schema.Struct({ total: usageNumber }),
})
export type UsageRow = typeof UsageRow.Type

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
      readonly usage: UsageRow
    }
  | {
      readonly type: "tool_execution_start"
      readonly toolName: string
      readonly args: unknown
    }
  | {
      readonly type: "tool_execution_end"
      readonly toolName: string
      readonly isError: boolean
      readonly detail?: string
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
  // from the agent that owns the messages. Rows decode against UsageRow in
  // invoke; drift fails loudly there.
  readonly usageRows: () => ReadonlyArray<unknown>
}

// The terminating emit tool's validated arguments, delivered by Pi after its
// JSON-Schema coercion pass (#4 §5). JSON by construction, but still
// untrusted: each stage re-decodes them against its own OutputContract.
export type EmitToolArgs = Schema.Json

// The terminating emit tool as the seam sees it: parameters are an already
// projected plain JSON Schema (Pi detects the missing TypeBox.Kind symbol and
// runs its JSON-Schema coercion path, #4 §5), and `execute` is called only
// when the harness validated the arguments — a failed validation surfaces
// only as tool_execution_start.
export interface EmitToolSpec {
  readonly name: string
  readonly description: string
  readonly parameters: JsonSchema.JsonSchema
  readonly execute: (args: EmitToolArgs) => void
}

export interface SessionConfig {
  // Stable identity for attribution, scripted selection, and diagnostics.
  // It names no shared cache partition; an adapter without a cacheGroupId
  // may still use it as this session's own (unshared) identity.
  readonly invocationId: string
  // The invocation's resolved seat, frozen in ReviewPlan. The live adapter
  // resolves it through Pi; the factory carries no independently configured
  // ambient model.
  readonly seat: Seat
  // Host path of the Run's frozen snapshot worktree. Filesystem-facing tools
  // observe it only through a per-invocation ReviewWorkspace overlay, and
  // Pi's non-tool plumbing (resource loader, session manager) keeps the real
  // path host-side; it is never model-visible.
  readonly cwd: string
  // Overrides Pi's stock system prompt. Must be non-empty: Pi treats an empty
  // string as "use the stock prompt" (#4 §2).
  readonly systemPrompt: string
  // Provider-neutral cache partition identity. An adapter may map this to a
  // native session/cache key. Ordinary invocations leave it absent.
  readonly cacheGroupId?: string
  readonly emitTool: EmitToolSpec
  // The complete non-emit capability set — which tools the session gets,
  // always ReviewWorkspace-backed. These are recreated as custom Pi tools
  // so their deadlines remain caller-owned.
  readonly tools: ReadonlyArray<"read" | "bash">
  readonly toolTimeoutMillis: number
  readonly bashTimeoutMillis: number
}

// The distinct steps an adapter's `open` can fail in — the coarse-error
// operation discriminator (house style rule 7). The seam enumerates every
// adapter's operations so the union stays a closed, typo-proof set.
export type InvocationSetupOperation =
  | "validate-config"
  | "model-runtime"
  | "resolve-model"
  | "session-construction"
  | "open"
  | "prompt"

// "No outcome can exist" — session construction failed (CONTEXT.md: Failure).
// `cause` retains the original thrown value for diagnosis at this multi-step
// external boundary; `reason` is the human-readable rendering.
export class InvocationSetupError extends Data.TaggedError(
  "InvocationSetupError",
)<{
  readonly operation: InvocationSetupOperation
  readonly reason: string
  readonly cause?: unknown
}> {}

// "No outcome can exist" — the adapter broke its contract: a drifted usage
// shape, an event that no longer decodes. Raised even when an emit was
// captured, because a silently-$0 invocation is indistinguishable from a
// healthy one (ADR 0001, #4 §8).
export class AdapterContractViolation extends Data.TaggedError(
  "AdapterContractViolation",
)<{ readonly reason: string }> {}

export type InvocationFailure =
  | InvocationSetupError
  | AdapterContractViolation

export interface HarnessSessionFactoryContract {
  // `open` may do blocking work (credential/catalog reads), so invocation
  // gives it a narrower startup bound inside the absolute overall deadline.
  // Interruptibility of the acquire is the invocation engine's job.
  readonly open: (
    config: SessionConfig,
  ) => Effect.Effect<HarnessSession, InvocationSetupError, Scope.Scope>
}

// The single primary testing seam. Live layer: pi-live.ts. Test layer: the
// scripted adapter (scripted.ts) — behavior-parameterized, so it plays the
// role a static Fake would.
export class HarnessSessionFactory extends Context.Service<
  HarnessSessionFactory,
  HarnessSessionFactoryContract
>()("gauntlet/HarnessSessionFactory") {}
