import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Function from "effect/Function"
import * as Option from "effect/Option"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import {
  type AgentOutcome,
  type AgentUsage,
  Termination,
  type Termination as TerminationType,
} from "../domain/agent-outcome.ts"
import type { Seat } from "../domain/recipe.ts"
import {
  AdapterContractViolation,
  type EmitToolArgs,
  type HarnessEvent,
  type HarnessSession,
  HarnessSessionFactory,
  type InvocationFailure,
  InvocationSetupError,
  type ReplayableConversationPrefix,
  type StopReason,
  UsageRow,
} from "./harness-session.ts"
import type { OutputContract } from "./output-contract.ts"

const MAX_CORRECTIVE_TURNS = 2
const MIN_RETRY_REMAINING_MILLIS = 5_000

export interface InvocationDeadlines {
  readonly overallMillis: number
  readonly startupMillis: number
  readonly firstResponseMillis: number
  readonly toolMillis: number
  readonly bashMillis: number
}

export interface InvokeInput<O> {
  readonly seat: Seat
  readonly cwd: string
  readonly systemPrompt: string
  readonly prompt: string
  readonly cacheGroupId?: string
  readonly conversationPrefix?: ReplayableConversationPrefix
  readonly contract: OutputContract<O>
  readonly tools: ReadonlyArray<"read" | "bash">
  readonly deadlines: InvocationDeadlines
  // Explicit cancellation provenance. Ordinary fiber interruption remains
  // interruption; it is not relabeled as an AgentOutcome.
  readonly signal?: AbortSignal
}

export const PreloadOutput = Schema.Struct({
  acknowledgment: Schema.NonEmptyString,
})
export interface PreloadOutput
  extends Schema.Schema.Type<typeof PreloadOutput> {}

export type PreloadInput<O> = Omit<
  InvokeInput<O>,
  "contract" | "conversationPrefix"
> & {
  // The preload has a fixed output of its own. This contract is advertised
  // solely so its tool metadata is byte-identical to the follower session.
  readonly followerContract: OutputContract<O>
  readonly expectedAcknowledgment: string
}

export interface PreloadResult {
  readonly outcome: AgentOutcome<PreloadOutput>
  readonly conversationPrefix?: ReplayableConversationPrefix
}

interface TerminalEvidence {
  readonly stopReason: StopReason
  readonly errorMessage: string | undefined
}

interface CaptureCommon {
  readonly terminal: TerminalEvidence | undefined
  readonly acceptedActivity: boolean
  readonly rawUsageRows: ReadonlyArray<Schema.Json>
  readonly usageSweepError: string | undefined
  readonly violations: ReadonlyArray<string>
  readonly diagnostics: ReadonlyArray<string>
  readonly toolCallCount: number
}

type CaptureState = Data.TaggedEnum<{
  Empty: CaptureCommon
  Salvaged: CaptureCommon & { readonly raws: ReadonlyArray<unknown> }
  Validated: CaptureCommon & {
    readonly raw: unknown
    readonly duplicateCount: number
  }
}>

const CaptureState = Data.taggedEnum<CaptureState>()
const isValidatedCapture = CaptureState.$is("Validated")
const isSalvagedCapture = CaptureState.$is("Salvaged")

type CaptureFact =
  | { readonly type: "prompt_started" }
  | { readonly type: "event"; readonly event: HarnessEvent; readonly emitToolName: string }
  | { readonly type: "validated_emit"; readonly raw: unknown }
  | { readonly type: "usage_rows"; readonly rows: ReadonlyArray<Schema.Json> }
  | { readonly type: "usage_sweep_error"; readonly reason: string }
  | { readonly type: "diagnostic"; readonly message: string }

const commonOf = (state: CaptureState): CaptureCommon =>
  CaptureState.$match(state, {
    Empty: (common) => common,
    Salvaged: ({ raws: _raws, ...common }) => common,
    Validated: ({ raw: _raw, duplicateCount: _duplicates, ...common }) =>
      common,
  })

const withCommon = (
  state: CaptureState,
  common: CaptureCommon,
): CaptureState =>
  CaptureState.$match(state, {
    Empty: () => CaptureState.Empty(common),
    Salvaged: ({ raws }) => CaptureState.Salvaged({ ...common, raws }),
    Validated: ({ raw, duplicateCount }) =>
      CaptureState.Validated({ ...common, raw, duplicateCount }),
  })

// Pure evidence reducer. The callback-facing accumulator below is only a
// mutable cell around this tagged state, so contradictory boolean/value
// combinations cannot be represented.
const reduceCapture = (
  state: CaptureState,
  fact: CaptureFact,
): CaptureState => {
  const common = commonOf(state)
  switch (fact.type) {
    case "prompt_started": {
      return withCommon(state, { ...common, terminal: undefined })
    }
    case "event": {
      const event = fact.event
      switch (event.type) {
        case "message_start": {
          return withCommon(state, {
            ...common,
            acceptedActivity: true,
            violations: isValidatedCapture(state)
              ? [
                  ...common.violations,
                  `assistant activity continued after validated ${fact.emitToolName}`,
                ]
              : common.violations,
          })
        }
        case "message_end": {
          return withCommon(state, {
            ...common,
            acceptedActivity: true,
            terminal: {
              stopReason: event.stopReason,
              errorMessage: event.errorMessage,
            },
          })
        }
        case "tool_execution_start": {
          const active = {
            ...common,
            acceptedActivity: true,
            toolCallCount: common.toolCallCount + 1,
          }
          if (event.toolName !== fact.emitToolName) {
            return withCommon(state, active)
          }
          if (isValidatedCapture(state)) return withCommon(state, active)
          return CaptureState.Salvaged({
            ...active,
            raws: isSalvagedCapture(state)
              ? [...state.raws, event.args]
              : [event.args],
          })
        }
        case "tool_execution_end": {
          const diagnostic =
            event.isError
              ? `tool ${event.toolName} failed${event.detail === undefined ? "" : `: ${event.detail}`}`
              : undefined
          return withCommon(state, {
            ...common,
            acceptedActivity: true,
            diagnostics:
              diagnostic === undefined
                ? common.diagnostics
                : [...common.diagnostics, diagnostic],
          })
        }
        case "contract_violation": {
          return withCommon(state, {
            ...common,
            violations: [...common.violations, event.reason],
          })
        }
      }
    }
    case "validated_emit": {
      return isValidatedCapture(state)
        ? CaptureState.Validated({
            ...common,
            raw: state.raw,
            duplicateCount: state.duplicateCount + 1,
          })
        : CaptureState.Validated({
            ...common,
            raw: fact.raw,
            duplicateCount: 0,
          })
    }
    case "usage_rows": {
      return withCommon(state, { ...common, rawUsageRows: fact.rows })
    }
    case "usage_sweep_error": {
      return withCommon(state, {
        ...common,
        usageSweepError: fact.reason,
      })
    }
    case "diagnostic": {
      return withCommon(state, {
        ...common,
        diagnostics: [...common.diagnostics, fact.message],
      })
    }
  }
}

interface CaptureAccumulator {
  readonly dispatch: (fact: CaptureFact) => void
  readonly snapshot: () => CaptureState
}

const makeCaptureAccumulator = (): CaptureAccumulator => {
  let state: CaptureState = CaptureState.Empty({
    terminal: undefined,
    acceptedActivity: false,
    rawUsageRows: [],
    usageSweepError: undefined,
    violations: [],
    diagnostics: [],
    toolCallCount: 0,
  })
  return {
    dispatch: (fact) => {
      state = reduceCapture(state, fact)
    },
    snapshot: () => state,
  }
}

interface CapturedSession {
  readonly session: HarnessSession
  readonly events: Queue.Queue<HarnessEvent>
}

const bestEffortDispose = (
  session: HarnessSession,
  capture: CaptureAccumulator,
) =>
  Effect.try({
    try: () => session.dispose(),
    catch: (cause) => String(cause),
  }).pipe(
    Effect.catch((reason) =>
      Effect.sync(() => {
        capture.dispatch({
          type: "diagnostic",
          message: `dispose failed during session teardown: ${reason}`,
        })
      }).pipe(
        Effect.andThen(
          Effect.logWarning(
            `dispose failed during session teardown: ${reason}`,
          ),
        ),
      ),
    ),
  )

const openCapturedSession = Effect.fn(
  "gauntlet.invocation.open_captured_session",
)(function* <O>(
  input: InvokeInput<O> | PreloadInput<O>,
  capture: CaptureAccumulator,
  mode: "invocation" | "preload" = "invocation",
) {
  const factory = yield* HarnessSessionFactory
  const followerContract = "contract" in input
    ? input.contract
    : input.followerContract
  const openConfig = {
    seat: input.seat,
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    emitTool: {
      name: followerContract.toolName,
      description: followerContract.description,
      parameters: Schema.toJsonSchemaDocument(followerContract.schema).schema,
      execute: (raw: EmitToolArgs) =>
        capture.dispatch({ type: "validated_emit", raw }),
    },
    tools: input.tools,
    toolTimeoutMillis: input.deadlines.toolMillis,
    bashTimeoutMillis: input.deadlines.bashMillis,
    mode,
  }
  const cacheConfigured = input.cacheGroupId === undefined
    ? openConfig
    : { ...openConfig, cacheGroupId: input.cacheGroupId }
  const conversationPrefix = "conversationPrefix" in input
    ? input.conversationPrefix
    : undefined
  const sessionConfig = conversationPrefix === undefined
    ? cacheConfigured
    : {
        ...cacheConfigured,
        conversationPrefix,
      }
  const session = yield* Effect.acquireRelease(
    factory.open(sessionConfig),
    (opened) =>
      Effect.sync(() => {
        try {
          const rows = opened.usageRows().map(jsonSafeRow)
          capture.dispatch({ type: "usage_rows", rows })
        } catch (cause) {
          capture.dispatch({
            type: "usage_sweep_error",
            reason: String(cause),
          })
        }
      }).pipe(Effect.andThen(bestEffortDispose(opened, capture))),
    { interruptible: true },
  )

  const events = yield* Queue.unbounded<HarnessEvent>()
  yield* Effect.acquireRelease(
    Effect.sync(() =>
      session.subscribe((event) => {
        capture.dispatch({
          type: "event",
          event,
          emitToolName: followerContract.toolName,
        })
        Queue.offerUnsafe(events, event)
      }),
    ),
    (unsubscribe) => Effect.sync(unsubscribe),
  )
  return { session, events } satisfies CapturedSession
})

const abortAbandonedSession = (session: HarnessSession): Effect.Effect<void> =>
  Effect.sync(() => {
    void session.abort().catch(() => undefined)
  })

const signalFirstResponse = (
  events: Queue.Queue<HarnessEvent>,
  firstResponse: Deferred.Deferred<void>,
) =>
  Effect.gen(function* () {
    while (true) {
      const event = yield* Queue.take(events)
      if (event.type === "message_start") {
        yield* Deferred.succeed(firstResponse, undefined)
        return
      }
    }
  })

type PromptEnding =
  | { readonly type: "settled"; readonly rejection: string | undefined }
  | { readonly type: "first-response-timeout" }

const runPrompt = Effect.fn("gauntlet.invocation.run_prompt")(function* (
  session: HarnessSession,
  events: Queue.Queue<HarnessEvent>,
  prompt: string,
  firstResponseMillis: number,
  capture: CaptureAccumulator,
) {
  capture.dispatch({ type: "prompt_started" })
  while (Option.isSome(yield* Queue.poll(events))) {
    // Drain terminal evidence from the preceding corrective prompt without
    // waiting for a new event. Queue.takeAll is intentionally blocking in v4.
  }

  const firstResponse = yield* Deferred.make<void>()
  const responseFiber = yield* Effect.forkScoped(
    signalFirstResponse(events, firstResponse),
  )
  const promptFiber = yield* Effect.forkScoped(
    Effect.tryPromise({
      try: () => session.prompt(prompt),
      catch: (cause) => String(cause),
    }).pipe(
      Effect.match({
        onFailure: (rejection): PromptEnding => ({
          type: "settled",
          rejection,
        }),
        onSuccess: (): PromptEnding => ({
          type: "settled",
          rejection: undefined,
        }),
      }),
    ),
  )

  const watchdog = Deferred.await(firstResponse).pipe(
    Effect.timeoutOption(Duration.millis(firstResponseMillis)),
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed({
            type: "first-response-timeout" as const,
          } satisfies PromptEnding),
        onSome: () => Effect.never,
      }),
    ),
  )

  const ending = yield* Effect.raceFirst(Fiber.join(promptFiber), watchdog)
  yield* Fiber.interrupt(responseFiber)
  if (ending.type === "first-response-timeout") {
    capture.dispatch({
      type: "diagnostic",
      message: `first response exceeded ${String(firstResponseMillis)}ms`,
    })
    yield* Fiber.interrupt(promptFiber)
    yield* abortAbandonedSession(session)
  }
  return ending
})

const correctivePrompt = (toolName: string) =>
  `You ended without calling ${toolName}. Call ${toolName} now, exactly once, with the result you already prepared. Do not answer in prose.`

const remainingMillis = (absoluteDeadline: number) =>
  Clock.currentTimeMillis.pipe(
    Effect.map((now) => Math.max(0, absoluteDeadline - now)),
  )

interface CurrentSession {
  value: HarnessSession | undefined
}

const runAttempt = Effect.fn("gauntlet.invocation.run_attempt")(function* <O>(
  input: InvokeInput<O>,
  absoluteDeadline: number,
  capture: CaptureAccumulator,
  currentSession: CurrentSession,
) {
  const opened = yield* openCapturedSession(input, capture).pipe(
    Effect.timeoutOption(Duration.millis(input.deadlines.startupMillis)),
  )
  if (Option.isNone(opened)) {
    capture.dispatch({
      type: "diagnostic",
      message: `session construction exceeded ${String(input.deadlines.startupMillis)}ms`,
    })
    return Termination.cases.FirstResponseTimeout.make({})
  }

  const { session, events } = opened.value
  currentSession.value = session
  let turns = 0
  let prompt = input.prompt

  while (true) {
    const ending = yield* runPrompt(
      session,
      events,
      prompt,
      input.deadlines.firstResponseMillis,
      capture,
    )
    if (ending.type === "first-response-timeout") {
      return Termination.cases.FirstResponseTimeout.make({})
    }

    const state = capture.snapshot()
    const common = commonOf(state)
    if (ending.rejection !== undefined) {
      if (common.violations.length > 0) {
        return yield* new AdapterContractViolation({
          reason: common.violations.join("; "),
        })
      }
      if (common.acceptedActivity) {
        return yield* new AdapterContractViolation({
          reason: `prompt rejected after accepted session activity: ${ending.rejection}`,
        })
      }
      return yield* new InvocationSetupError({
        operation: "prompt",
        reason: ending.rejection,
      })
    }

    const terminal = common.terminal
    if (terminal === undefined) {
      return yield* new AdapterContractViolation({
        reason: "prompt settled without terminal assistant evidence",
      })
    }

    switch (terminal.stopReason) {
      case "length": {
        return Termination.cases.ContextLimit.make({})
      }
      case "error": {
        capture.dispatch({
          type: "diagnostic",
          message: `provider failed${terminal.errorMessage === undefined ? "" : `: ${terminal.errorMessage}`}`,
        })
        return Termination.cases.ProviderFailed.make({})
      }
      case "pending":
      case "deferred":
      case "aborted": {
        return yield* new AdapterContractViolation({
          reason: `prompt settled with uncaused stop reason ${terminal.stopReason}`,
        })
      }
      case "stop":
      case "toolUse": {
        if (isValidatedCapture(state)) {
          if (turns > 0) {
            capture.dispatch({
              type: "diagnostic",
              message: `validated emit succeeded after ${String(turns)} corrective turn${turns === 1 ? "" : "s"}`,
            })
          }
          return Termination.cases.Completed.make({})
        }
        const remaining = yield* remainingMillis(absoluteDeadline)
        if (
          turns >= MAX_CORRECTIVE_TURNS ||
          remaining < MIN_RETRY_REMAINING_MILLIS
        ) {
          if (remaining < MIN_RETRY_REMAINING_MILLIS) {
            capture.dispatch({
              type: "diagnostic",
              message: "corrective turn skipped because less than 5000ms remained",
            })
          }
          return Termination.cases.MissingEmit.make({ correctiveTurns: turns })
        }
        turns += 1
        prompt = correctivePrompt(input.contract.toolName)
      }
    }
  }
})

const isFreshRetryable = (termination: TerminationType): boolean =>
  Termination.guards.FirstResponseTimeout(termination)

type InvocationLifecycleInput = Omit<
  InvokeInput<never>,
  "contract" | "conversationPrefix"
>

const validateInput = (input: InvocationLifecycleInput) =>
  Effect.gen(function* () {
    if (input.systemPrompt.trim() === "") {
      return yield* new InvocationSetupError({
        operation: "validate-config",
        reason: "systemPrompt must be non-empty",
      })
    }
    if (input.prompt.trim() === "") {
      return yield* new InvocationSetupError({
        operation: "validate-config",
        reason: "prompt must be non-empty",
      })
    }
    for (const [name, value] of Object.entries(input.deadlines)) {
      if (!Number.isFinite(value) || value <= 0) {
        return yield* new InvocationSetupError({
          operation: "validate-config",
          reason: `${name} must be a positive finite number`,
        })
      }
    }
  })

const waitForAbort = (signal: AbortSignal): Effect.Effect<void> =>
  Effect.callback<void>((resume) => {
    if (signal.aborted) {
      resume(Effect.void)
      return
    }
    const onAbort = () => resume(Effect.void)
    signal.addEventListener("abort", onAbort, { once: true })
    return Effect.sync(() => signal.removeEventListener("abort", onAbort))
  })

const decodeUsageRow = Schema.decodeUnknownEffect(UsageRow)
const encodeJsonString = Schema.encodeUnknownSync(
  Schema.fromJsonString(Schema.Unknown),
)
const decodeJsonValue = Schema.decodeUnknownSync(
  Schema.fromJsonString(Schema.Json),
)

// Normalizes a raw usage row into the journal's JSON contract. The
// stringify/parse round-trip drops undefined fields (as JSON.stringify
// would) and throws on non-serializable rows.
const jsonSafeRow = Function.compose(encodeJsonString, decodeJsonValue)

const usageFrom = (states: ReadonlyArray<CaptureState>) =>
  Effect.gen(function* () {
    const decodedRows = yield* Effect.forEach(states, (state) => {
      const common = commonOf(state)
      if (common.violations.length > 0) {
        return Effect.fail(
          new AdapterContractViolation({
            reason: common.violations.join("; "),
          }),
        )
      }
      if (common.usageSweepError !== undefined) {
        return Effect.fail(
          new AdapterContractViolation({
            reason: `usage sweep threw: ${common.usageSweepError}`,
          }),
        )
      }
      return Effect.forEach(common.rawUsageRows, (row) =>
        decodeUsageRow(row).pipe(
          Effect.mapError(
            () =>
              new AdapterContractViolation({
                reason: "usage row does not match Pi's accounting contract",
              }),
          ),
        ),
      )
    })
    const rawRows = states.flatMap((state) => commonOf(state).rawUsageRows)
    let input = 0
    let output = 0
    let cacheRead = 0
    let cacheWrite = 0
    let reasoning = 0
    let costUsd = 0
    for (const row of decodedRows.flat()) {
      input += row.input
      output += row.output
      cacheRead += row.cacheRead
      cacheWrite += row.cacheWrite
      reasoning += row.reasoning ?? 0
      costUsd += row.cost.total
    }
    return {
      input,
      output,
      cacheRead,
      cacheWrite,
      reasoning,
      costUsd,
      rawRows,
    } satisfies AgentUsage
  })

const outputFrom = <O>(
  contract: OutputContract<O>,
  states: ReadonlyArray<CaptureState>,
  diagnostics: Array<string>,
) =>
  Effect.gen(function* () {
    const decode = Schema.decodeUnknownEffect(contract.schema, {
      onExcessProperty: "error",
    })
    const validated = states.filter(isValidatedCapture)
    for (const state of validated) {
      if (state.duplicateCount > 0) {
        diagnostics.push(
          `${contract.toolName} was called ${String(state.duplicateCount + 1)} times; retained the first validated call`,
        )
      }
    }
    const newestValidated = validated.at(-1)
    if (newestValidated !== undefined) {
      return yield* decode(newestValidated.raw).pipe(
        Effect.mapError(
          () =>
            new AdapterContractViolation({
              reason: `validated ${contract.toolName} arguments failed their OutputContract decoder`,
            }),
        ),
        Effect.map(Option.some),
      )
    }

    const salvaged = states
      .filter(isSalvagedCapture)
      .flatMap((state) => state.raws)
      .reverse()
    for (const [index, raw] of salvaged.entries()) {
      const decoded = yield* decode(raw).pipe(
        Effect.match({
          onFailure: () => Option.none<O>(),
          onSuccess: Option.some,
        }),
      )
      if (Option.isSome(decoded)) {
        diagnostics.push(
          `${contract.toolName} output recovered from pre-validation arguments`,
        )
        return decoded
      }
      diagnostics.push(
        `${contract.toolName} salvage candidate ${String(index + 1)} did not decode`,
      )
    }
    return Option.none<O>()
  })

const finalizeOutcome = <O>(
  input: InvokeInput<O>,
  termination: TerminationType,
  captures: ReadonlyArray<CaptureAccumulator>,
  globalDiagnostics: ReadonlyArray<string>,
  durationMillis: number,
): Effect.Effect<AgentOutcome<O>, AdapterContractViolation> =>
  Effect.gen(function* () {
    const states = captures.map((capture) => capture.snapshot())
    const diagnostics = [
      ...globalDiagnostics,
      ...states.flatMap((state) => commonOf(state).diagnostics),
    ]
    const usage = yield* usageFrom(states)
    const output = yield* outputFrom(input.contract, states, diagnostics)
    const outcome = {
      termination,
      usage,
      durationMillis,
      diagnostics,
    }
    return Option.isNone(output)
      ? outcome
      : { ...outcome, output: output.value }
  })

interface InvocationLifecycle<A> {
  readonly result: A
  readonly captures: ReadonlyArray<CaptureAccumulator>
  readonly diagnostics: ReadonlyArray<string>
  readonly durationMillis: number
}

// Startup, one fresh-session retry, cancellation, overall budget, disposal,
// and timing are one engine for ordinary and preload invocations. The two
// modes differ only in how an attempt interprets its terminal evidence.
const runInvocationLifecycle = <A>(
  input: InvocationLifecycleInput,
  run: (
    absoluteDeadline: number,
    capture: CaptureAccumulator,
    currentSession: CurrentSession,
  ) => Effect.Effect<
    A,
    InvocationFailure,
    HarnessSessionFactory | Scope.Scope
  >,
  terminationOf: (result: A) => TerminationType,
  terminalResult: (termination: TerminationType) => A,
): Effect.Effect<
  InvocationLifecycle<A>,
  InvocationFailure,
  HarnessSessionFactory
> => Effect.gen(function* () {
  yield* validateInput(input)
  const startedAt = yield* Clock.currentTimeMillis
  const absoluteDeadline = startedAt + input.deadlines.overallMillis
  const captures: Array<CaptureAccumulator> = []
  const diagnostics: Array<string> = []
  const currentSession: CurrentSession = { value: undefined }

  const runOne = (attempt: number) => {
    const capture = makeCaptureAccumulator()
    captures.push(capture)
    return Effect.scoped(
      run(absoluteDeadline, capture, currentSession),
    ).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          currentSession.value = undefined
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          diagnostics.push(`attempt ${String(attempt)} completed`)
        }),
      ),
    )
  }

  const runAttempts = Effect.gen(function* () {
    const first = yield* runOne(1)
    if (!isFreshRetryable(terminationOf(first))) return first
    const remaining = yield* remainingMillis(absoluteDeadline)
    if (remaining < MIN_RETRY_REMAINING_MILLIS) {
      diagnostics.push(
        "fresh invocation retry skipped because less than 5000ms remained",
      )
      return first
    }
    diagnostics.push("retrying first-response stall in one fresh session")
    return yield* runOne(2).pipe(
      Effect.catchTag("InvocationSetupError", (error) =>
        Effect.sync(() => {
          diagnostics.push(
            `fresh invocation retry failed during ${error.operation}: ${error.reason}; retained the first-response timeout outcome`,
          )
          return first
        }),
      ),
    )
  })

  const abortCurrent = Effect.sync(() => {
    const session = currentSession.value
    if (session !== undefined) void session.abort().catch(() => undefined)
  })

  const budgetEnding = Effect.sleep(
    Duration.millis(input.deadlines.overallMillis),
  ).pipe(
    Effect.andThen(
      Effect.sync(() => {
        diagnostics.push("overall invocation deadline exhausted")
      }),
    ),
    Effect.andThen(abortCurrent),
    Effect.as(terminalResult(Termination.cases.BudgetExhausted.make({}))),
  )

  const cancellationEnding =
    input.signal === undefined
      ? Effect.never
      : waitForAbort(input.signal).pipe(
          Effect.andThen(
            Effect.sync(() => {
              diagnostics.push("explicit cancellation requested")
            }),
          ),
          Effect.andThen(abortCurrent),
          Effect.as(terminalResult(Termination.cases.Interrupted.make({}))),
        )

  const result = yield* Effect.raceFirst(
    runAttempts,
    Effect.raceFirst(budgetEnding, cancellationEnding),
  )
  const finishedAt = yield* Clock.currentTimeMillis
  return {
    result,
    captures,
    diagnostics,
    durationMillis: Math.max(0, finishedAt - startedAt),
  }
})

export const invoke = Effect.fn("gauntlet.invocation.invoke")(function* <O>(
  input: InvokeInput<O>,
): Effect.fn.Return<
  AgentOutcome<O>,
  InvocationFailure,
  HarnessSessionFactory
> {
  const lifecycle = yield* runInvocationLifecycle<TerminationType>(
    input,
    (absoluteDeadline, capture, currentSession) =>
      runAttempt(input, absoluteDeadline, capture, currentSession),
    (termination) => termination,
    (termination) => termination,
  )
  return yield* finalizeOutcome(
    input,
    lifecycle.result,
    lifecycle.captures,
    lifecycle.diagnostics,
    lifecycle.durationMillis,
  )
})

interface PreloadAttempt {
  readonly termination: TerminationType
  readonly conversationPrefix?: ReplayableConversationPrefix
}

const runPreloadAttempt = Effect.fn(
  "gauntlet.invocation.run_preload_attempt",
)(function* <O>(
  input: PreloadInput<O>,
  capture: CaptureAccumulator,
  currentSession: CurrentSession,
) {
  const opened = yield* openCapturedSession(input, capture, "preload").pipe(
    Effect.timeoutOption(Duration.millis(input.deadlines.startupMillis)),
  )
  if (Option.isNone(opened)) {
    capture.dispatch({
      type: "diagnostic",
      message: `session construction exceeded ${String(input.deadlines.startupMillis)}ms`,
    })
    return {
      termination: Termination.cases.FirstResponseTimeout.make({}),
    } satisfies PreloadAttempt
  }

  const { session, events } = opened.value
  currentSession.value = session
  const ending = yield* runPrompt(
    session,
    events,
    input.prompt,
    input.deadlines.firstResponseMillis,
    capture,
  )
  if (ending.type === "first-response-timeout") {
    return {
      termination: Termination.cases.FirstResponseTimeout.make({}),
    } satisfies PreloadAttempt
  }

  const common = commonOf(capture.snapshot())
  if (ending.rejection !== undefined) {
    if (common.violations.length > 0) {
      return yield* new AdapterContractViolation({
        reason: common.violations.join("; "),
      })
    }
    if (common.acceptedActivity) {
      capture.dispatch({
        type: "diagnostic",
        message: `provider rejected preload after accepting session activity: ${ending.rejection}`,
      })
      return {
        termination: Termination.cases.ProviderFailed.make({}),
      } satisfies PreloadAttempt
    }
    return yield* new InvocationSetupError({
      operation: "prompt",
      reason: ending.rejection,
    })
  }
  if (common.terminal === undefined) {
    return yield* new AdapterContractViolation({
      reason: "preload prompt settled without terminal assistant evidence",
    })
  }
  if (common.toolCallCount > 0) {
    capture.dispatch({
      type: "diagnostic",
      message: `preload attempted ${String(common.toolCallCount)} forbidden tool call${common.toolCallCount === 1 ? "" : "s"}; no prefix was reused`,
    })
    return {
      termination: Termination.cases.ProviderFailed.make({}),
    } satisfies PreloadAttempt
  }

  switch (common.terminal.stopReason) {
    case "stop": {
      const conversationPrefix = session.captureConversationPrefix()
      if (conversationPrefix === undefined) {
        return yield* new AdapterContractViolation({
          reason: "preload completed without a replayable assistant response",
        })
      }
      if (conversationPrefix.assistantText !== input.expectedAcknowledgment) {
        capture.dispatch({
          type: "diagnostic",
          message: `preload acknowledgment did not exactly match the configured contract; no prefix was reused`,
        })
        return {
          termination: Termination.cases.ProviderFailed.make({}),
        } satisfies PreloadAttempt
      }
      return {
        termination: Termination.cases.Completed.make({}),
        conversationPrefix,
      } satisfies PreloadAttempt
    }
    case "length": {
      return {
        termination: Termination.cases.ContextLimit.make({}),
      } satisfies PreloadAttempt
    }
    case "error": {
      capture.dispatch({
        type: "diagnostic",
        message: `provider failed${common.terminal.errorMessage === undefined ? "" : `: ${common.terminal.errorMessage}`}`,
      })
      return {
        termination: Termination.cases.ProviderFailed.make({}),
      } satisfies PreloadAttempt
    }
    case "toolUse": {
      capture.dispatch({
        type: "diagnostic",
        message: "preload stopped for tool use without a captured tool event; no prefix was reused",
      })
      return {
        termination: Termination.cases.ProviderFailed.make({}),
      } satisfies PreloadAttempt
    }
    case "pending":
    case "deferred":
    case "aborted": {
      return yield* new AdapterContractViolation({
        reason: `preload prompt settled with uncaused stop reason ${common.terminal.stopReason}`,
      })
    }
  }
})

const finalizePreloadOutcome = (
  termination: TerminationType,
  conversationPrefix: ReplayableConversationPrefix | undefined,
  captures: ReadonlyArray<CaptureAccumulator>,
  globalDiagnostics: ReadonlyArray<string>,
  durationMillis: number,
): Effect.Effect<AgentOutcome<PreloadOutput>, AdapterContractViolation> =>
  Effect.gen(function* () {
    const states = captures.map((capture) => capture.snapshot())
    const diagnostics = [
      ...globalDiagnostics,
      ...states.flatMap((state) => commonOf(state).diagnostics),
    ]
    const usage = yield* usageFrom(states)
    const outcome = {
      termination,
      usage,
      durationMillis,
      diagnostics,
    }
    return conversationPrefix === undefined
      ? outcome
      : {
          ...outcome,
          output: { acknowledgment: conversationPrefix.assistantText },
        }
  })

// A preload is a real, bounded, metered AgentInvocation whose only successful
// product is an adapter-owned replay token. It never performs corrective turns:
// setup prose is the requested terminal response, and any tool use invalidates
// the prefix without changing the Finder work that follows.
export const preloadConversation = Effect.fn(
  "gauntlet.invocation.preload_conversation",
)(function* <O>(input: PreloadInput<O>): Effect.fn.Return<
  PreloadResult,
  InvocationFailure,
  HarnessSessionFactory
> {
  const lifecycle = yield* runInvocationLifecycle<PreloadAttempt>(
    input,
    (_absoluteDeadline, capture, currentSession) =>
      runPreloadAttempt(input, capture, currentSession),
    (result) => result.termination,
    (termination): PreloadAttempt => ({ termination }),
  )
  const outcome = yield* finalizePreloadOutcome(
    lifecycle.result.termination,
    lifecycle.result.conversationPrefix,
    lifecycle.captures,
    lifecycle.diagnostics,
    lifecycle.durationMillis,
  )
  return lifecycle.result.conversationPrefix === undefined
    ? { outcome }
    : { outcome, conversationPrefix: lifecycle.result.conversationPrefix }
})
