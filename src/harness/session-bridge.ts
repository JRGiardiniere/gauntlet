import * as Effect from "effect/Effect"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import {
  AdapterContractViolation,
  type EmitToolSpec,
  type HarnessEvent,
  type HarnessSession,
  HarnessSessionFactory,
  SessionOpenError,
  type StopReason,
  UsageRow,
} from "./harness-session.ts"

// The bridge between a HarnessSession and fiber-land — the invocation
// mechanics fixed by the prototype (#13) that every consumer of the seam
// shares, live or scripted:
//
//   - session acquisition is an INTERRUPTIBLE acquire, so a caller's startup
//     deadline can actually cut a hanging open loose (the default
//     uninterruptible acquire lets it sail past the bound)
//   - the usage sweep lives in the release finalizer, before dispose; LIFO
//     finalizer order gives unsubscribe → sweep → dispose, and finalizers run
//     on interruption, so accounting survives a budget interrupt
//   - event capture happens synchronously in the subscribe listener, into
//     state created OUTSIDE any timed region — the Queue carries cross-fiber
//     signals only (a pure Queue-consumer design has an end-of-run drain race)

// Mutable capture state, plain data on purpose. Callers create it before
// entering any timed region so it survives the interrupt that closes the
// scope.
export interface SessionCaptureState {
  validatedEmit: unknown
  hasValidatedEmit: boolean
  // Validated emit calls past the first. The emit contract is exactly-once;
  // the first call is kept and extras are counted, never silently last-wins.
  // Whether duplicates poison the outcome is invocation-engine policy (#18) —
  // the model repeating a tool call is model behavior, not adapter drift.
  duplicateValidatedEmits: number
  salvagedEmit: unknown
  hasSalvagedEmit: boolean
  stopReason: StopReason | undefined
  errorMessage: string | undefined
  usageRows: ReadonlyArray<unknown>
  usageSweepError: string | undefined
  violations: Array<string>
}

export const makeCaptureState = (): SessionCaptureState => ({
  validatedEmit: undefined,
  hasValidatedEmit: false,
  duplicateValidatedEmits: 0,
  salvagedEmit: undefined,
  hasSalvagedEmit: false,
  stopReason: undefined,
  errorMessage: undefined,
  usageRows: [],
  usageSweepError: undefined,
  violations: [],
})

// What the bridge hands back after the scoped region closes: everything the
// invocation engine needs to assemble an AgentOutcome, with the usage rows
// already decoded — or an AdapterContractViolation, emit or no emit.
export interface CaptureResult {
  readonly validatedEmit: unknown
  readonly hasValidatedEmit: boolean
  readonly duplicateValidatedEmits: number
  readonly salvagedEmit: unknown
  readonly hasSalvagedEmit: boolean
  readonly stopReason: StopReason | undefined
  readonly errorMessage: string | undefined
  readonly usageRows: ReadonlyArray<UsageRow>
  // The same rows verbatim, for the journal (ADR 0006: raw usage, verbatim).
  readonly rawUsageRows: ReadonlyArray<unknown>
}

export interface OpenSessionConfig {
  readonly systemPrompt: string
  readonly sessionId?: string
  // The bridge owns the validated-emit capture, so callers describe the tool
  // without an execute hook.
  readonly emitTool: Omit<EmitToolSpec, "execute">
}

export interface CapturedSession {
  readonly session: HarnessSession
  // Cross-fiber signals only: watchdogs and cache-warm listeners take from
  // here. The authoritative record is the synchronous capture in `state`.
  readonly events: Queue.Queue<HarnessEvent>
}

const captureEvent = (state: SessionCaptureState, emitToolName: string) =>
  (event: HarnessEvent) => {
    switch (event.type) {
      case "message_start": {
        break
      }
      case "message_end": {
        state.stopReason = event.stopReason
        state.errorMessage = event.errorMessage
        break
      }
      case "tool_execution_start": {
        // Raw pre-validation args: what the agent MEANT to report. Kept as a
        // fallback only — a clean validated call always wins (#4 §5).
        if (event.toolName === emitToolName) {
          state.salvagedEmit = event.args
          state.hasSalvagedEmit = true
        }
        break
      }
      case "contract_violation": {
        state.violations.push(event.reason)
        break
      }
    }
  }

// Open a session inside the current scope with capture wired up. Callers own
// every deadline: they wrap this (and the prompt that follows) in their own
// timeouts, and the interruptible acquire plus release-side sweep guarantee
// that whatever the interrupt timing, accounting state survives into
// `finalizeCapture`.
export const openCapturedSession = Effect.fn(
  "gauntlet.session_bridge.open_captured_session",
)(function* (config: OpenSessionConfig, state: SessionCaptureState) {
  // Guarded here so every adapter is covered: Pi treats an empty system
  // prompt as "use the stock prompt" (#4 §2) — a silently wrong review agent,
  // not a working one.
  if (config.systemPrompt === "") {
    return yield* new SessionOpenError({
      operation: "validate-config",
      reason: "systemPrompt must be non-empty — Pi treats an empty string as 'use the stock prompt'",
    })
  }

  const factory = yield* HarnessSessionFactory

  const session = yield* Effect.acquireRelease(
    factory.open({
      systemPrompt: config.systemPrompt,
      ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
      emitTool: {
        ...config.emitTool,
        execute: (args) => {
          if (state.hasValidatedEmit) {
            state.duplicateValidatedEmits += 1
            return
          }
          state.validatedEmit = args
          state.hasValidatedEmit = true
        },
      },
    }),
    (opened) =>
      Effect.sync(() => {
        // The accounting sweep happens inside release, before dispose —
        // dispose disconnects the session from the agent that owns the
        // messages — and release runs even when an interrupt fires.
        try {
          state.usageRows = opened.usageRows()
        } catch (cause) {
          state.usageSweepError = String(cause)
        }
        opened.dispose()
      }),
    { interruptible: true },
  )

  const events = yield* Queue.unbounded<HarnessEvent>()
  const capture = captureEvent(state, config.emitTool.name)
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      session.subscribe((event) => {
        capture(event)
        Queue.offerUnsafe(events, event)
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  )

  return { session, events } satisfies CapturedSession
})

// Fire-and-forget, always: Pi's abort awaits waitForIdle and can hang forever
// (#4 §4). Gauntlet never re-prompts an aborted session, so the abort must
// never sit on anyone's critical path.
export const abortAbandonedSession = (
  session: HarnessSession,
): Effect.Effect<void> =>
  Effect.sync(() => {
    void session.abort().catch(() => undefined)
  })

const decodeUsageRow = Schema.decodeUnknownEffect(UsageRow)

// Render a drifted row for the violation message without letting the
// rendering itself blow up: JSON.stringify throws on bigint and circular
// values, which would turn the typed failure into a defect.
const describeRow = (row: unknown): string => {
  try {
    return JSON.stringify(row) ?? String(row)
  } catch {
    return String(row)
  }
}

// Turn surviving capture state into data the invocation engine can assemble
// from — or fail as AdapterContractViolation. Ordering is deliberate: a
// violation fails the invocation even when an emit was captured, because a
// silently-$0 result would be taken for a healthy one (#4 §8).
export const finalizeCapture = Effect.fn(
  "gauntlet.session_bridge.finalize_capture",
)(function* (state: SessionCaptureState) {
  if (state.violations.length > 0) {
    return yield* new AdapterContractViolation({
      reason: state.violations.join("; "),
    })
  }
  if (state.usageSweepError !== undefined) {
    return yield* new AdapterContractViolation({
      reason: `usage sweep threw: ${state.usageSweepError}`,
    })
  }

  const usageRows: Array<UsageRow> = []
  for (const row of state.usageRows) {
    const decoded = yield* decodeUsageRow(row).pipe(
      Effect.mapError(
        () =>
          new AdapterContractViolation({
            reason: `usage row does not match Pi's contract: ${describeRow(row)}`,
          }),
      ),
    )
    usageRows.push(decoded)
  }

  return {
    validatedEmit: state.validatedEmit,
    hasValidatedEmit: state.hasValidatedEmit,
    duplicateValidatedEmits: state.duplicateValidatedEmits,
    salvagedEmit: state.salvagedEmit,
    hasSalvagedEmit: state.hasSalvagedEmit,
    stopReason: state.stopReason,
    errorMessage: state.errorMessage,
    usageRows,
    rawUsageRows: state.usageRows,
  } satisfies CaptureResult
})
