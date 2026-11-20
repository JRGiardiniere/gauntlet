import * as Array from "effect/Array"
import * as Clock from "effect/Clock"
import * as Data from "effect/Data"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as Option from "effect/Option"
import * as Ref from "effect/Ref"
import * as Result from "effect/Result"
import type * as Scope from "effect/Scope"
import {
  type AgentOutcome,
  type AgentUsage,
  Termination,
} from "../domain/agent-outcome.ts"
import type { Seat } from "../domain/recipe.ts"
import {
  AdapterContractViolation,
  type EmitToolSpec,
  type HarnessSession,
  HarnessSessionFactory,
  type InspectionTool,
  type InvocationFailure,
  InvocationSetupError,
  TurnEnd,
  type TurnResult,
  type UsageRow,
} from "./harness-session.ts"
import {
  checkOutputContract,
  decodeOutputContract,
  type OutputContract,
  projectOutputContract,
} from "./output-contract.ts"

// One AgentInvocation: a session, up to two corrective turns when a turn
// ends without an emit, and one overall deadline. A strict-decoding failure
// never reaches this loop: the Host hands it back to the model as a tool
// error inside the same turn.

const MAX_CORRECTIVE_TURNS = 2

// How long a deadline waits for the Host to stop the session and report what
// the cut turn had spent.
const CUT_SHORT_GRACE = Duration.seconds(10)

export interface InvokeInput<O> {
  readonly invocationId: string
  readonly role: string
  readonly seat: Seat
  readonly workspace: string
  readonly dependencies?: ReadonlyArray<string>
  readonly systemPrompt: string
  readonly prompt: string
  readonly tools: ReadonlyArray<InspectionTool>
  readonly contract: OutputContract<O>
  readonly cacheGroup?: string
  readonly deadlineMillis: number
}

export type PrefixSignal = Data.TaggedEnum<{
  PrefixObserved: {}
  PrefixNotObserved: {}
}>

export const PrefixSignal = Data.taggedEnum<PrefixSignal>()

export interface RunningInvocation<O> {
  readonly firstResponse: Effect.Effect<PrefixSignal>
  readonly outcome: Effect.Effect<AgentOutcome<O>, InvocationFailure>
}

const correctivePrompt = (toolName: string) =>
  `You ended without calling ${toolName}. Call ${toolName} now, exactly once, with the result you already prepared. Do not answer in prose.`

export const emitToolSpec = <O>(contract: OutputContract<O>): EmitToolSpec => ({
  name: contract.toolName,
  description: contract.description,
  parameters: projectOutputContract(contract).schema,
  check: (raw) =>
    Result.match(checkOutputContract(contract)(raw), {
      onFailure: (error) => String(error),
      onSuccess: () => undefined,
    }),
})

const validateInput = <O>(input: InvokeInput<O>) =>
  Effect.gen(function* () {
    if (input.systemPrompt.trim() === "") {
      return yield* InvocationSetupError.make({ reason: "systemPrompt must be non-empty" })
    }

    if (input.prompt.trim() === "") {
      return yield* InvocationSetupError.make({ reason: "prompt must be non-empty" })
    }

    if (!Number.isFinite(input.deadlineMillis) || input.deadlineMillis <= 0) {
      return yield* InvocationSetupError.make({ reason: "deadlineMillis must be a positive finite number" })
    }
  })

// Each finished turn lands in `turns` as it ends, so a deadline that cuts the
// loop short still accounts for every turn before it.
const runTurns = (
  session: HarnessSession,
  input: InvokeInput<unknown>,
  turns: Ref.Ref<ReadonlyArray<TurnResult>>,
): Effect.Effect<Termination, AdapterContractViolation> =>
  Effect.gen(function* () {
    let text = input.prompt

    for (let corrective = 0; ; corrective += 1) {
      const result = yield* session.turn(text)
      yield* Ref.update(turns, Array.append(result))

      // Undefined only for a Stopped turn that still has a corrective turn left.
      const termination: Termination | undefined = TurnEnd.$match(result.end, {
        Emitted: () => Termination.cases.Completed.make({}),
        ContextLimit: () => Termination.cases.ContextLimit.make({}),
        ProviderFailed: () => Termination.cases.ProviderFailed.make({}),
        Interrupted: () => Termination.cases.Interrupted.make({}),
        Stopped: () =>
          corrective >= MAX_CORRECTIVE_TURNS
            ? Termination.cases.MissingEmit.make({ correctiveTurns: corrective })
            : undefined,
      })

      if (termination !== undefined) return termination

      text = correctivePrompt(input.contract.toolName)
    }
  })

const usageOf = (rows: ReadonlyArray<UsageRow>): AgentUsage => ({
  input: Array.reduce(rows, 0, (sum, row) => sum + row.input),
  output: Array.reduce(rows, 0, (sum, row) => sum + row.output),
  cacheRead: Array.reduce(rows, 0, (sum, row) => sum + row.cacheRead),
  cacheWrite: Array.reduce(rows, 0, (sum, row) => sum + row.cacheWrite),
  reasoning: Array.reduce(rows, 0, (sum, row) => sum + row.reasoning),
  rawRows: Array.map(rows, (row) => ({ ...row })),
})

const turnDiagnostics = (turns: ReadonlyArray<TurnResult>): ReadonlyArray<string> =>
  Array.flatMap(turns, (turn) => [
    ...turn.diagnostics,
    ...TurnEnd.$match(turn.end, {
      Emitted: () => [],
      Stopped: () => [],
      ContextLimit: () => ["context limit reached"],
      ProviderFailed: ({ reason }) => [`provider failed: ${reason}`],
      Interrupted: ({ reason }) => [`interrupted: ${reason}`],
    }),
  ])

const finalizeOutcome = <O>(
  input: InvokeInput<O>,
  termination: Termination,
  turns: ReadonlyArray<TurnResult>,
  cutShort: ReadonlyArray<UsageRow>,
  durationMillis: number,
): Effect.Effect<AgentOutcome<O>, AdapterContractViolation> =>
  Effect.gen(function* () {
    const diagnostics = [...turnDiagnostics(turns)]

    if (Termination.guards.BudgetExhausted(termination)) {
      diagnostics.push("overall invocation deadline exhausted")
    }

    if (Termination.guards.Completed(termination) && turns.length > 1) {
      const corrective = turns.length - 1
      diagnostics.push(
        `validated emit succeeded after ${String(corrective)} corrective turn${corrective === 1 ? "" : "s"}`,
      )
    }

    const outcome = {
      termination,
      usage: usageOf([...Array.flatMap(turns, (turn) => turn.usage), ...cutShort]),
      toolCalls: Array.reduce(turns, { total: 0, errored: 0, erroredPaths: Array.empty<string>() }, (sum, turn) => ({
        total: sum.total + turn.toolCalls.total,
        errored: sum.errored + turn.toolCalls.errored,
        erroredPaths: Array.dedupe([...sum.erroredPaths, ...(turn.toolCalls.erroredPaths ?? [])]),
      })),
      durationMillis,
      diagnostics,
    }

    const emitted = Array.findLast(turns, (turn) => TurnEnd.$is("Emitted")(turn.end))

    if (Option.isNone(emitted) || !TurnEnd.$is("Emitted")(emitted.value.end)) return outcome

    const output = yield* decodeOutputContract(input.contract)(emitted.value.end.raw).pipe(
      Effect.mapError((error) =>
        AdapterContractViolation.make({
          reason: `validated ${input.contract.toolName} arguments failed their OutputContract decoder: ${String(error)}`,
        })),
    )

    return { ...outcome, output }
  })

const invokeInternal = <O>(
  input: InvokeInput<O>,
  firstToken?: Deferred.Deferred<PrefixSignal>,
): Effect.Effect<AgentOutcome<O>, InvocationFailure, HarnessSessionFactory> =>
  Effect.gen(function* () {
    yield* validateInput(input)
    const factory = yield* HarnessSessionFactory
    const startedAt = yield* Clock.currentTimeMillis
    const turns = yield* Ref.make<ReadonlyArray<TurnResult>>([])

    const spec = {
      invocationId: input.invocationId,
      role: input.role,
      seat: input.seat,
      workspace: input.workspace,
      dependencies: input.dependencies,
      systemPrompt: input.systemPrompt,
      tools: input.tools,
      emit: emitToolSpec(input.contract),
    }

    const cutShort = yield* Ref.make<ReadonlyArray<UsageRow>>([])

    const termination = yield* Effect.scoped(
      Effect.gen(function* () {
        let opened: HarnessSession | undefined

        const ended = yield* Effect.gen(function* () {
          const session = yield* factory.open(
            input.cacheGroup === undefined ? spec : { ...spec, cacheGroup: input.cacheGroup },
          )

          opened = session

          if (firstToken !== undefined) {
            yield* session.firstToken.pipe(
              Effect.andThen(Deferred.succeed(firstToken, PrefixSignal.PrefixObserved())),
              Effect.forkScoped,
            )
          }

          return yield* runTurns(session, input, turns)
        }).pipe(Effect.timeoutOption(Duration.millis(input.deadlineMillis)))

        if (Option.isSome(ended)) return ended.value

        if (opened !== undefined) {
          const rows = yield* opened.cutShort.pipe(Effect.timeoutOption(CUT_SHORT_GRACE))
          yield* Ref.set(cutShort, Option.getOrElse(rows, () => []))
        }

        return Termination.cases.BudgetExhausted.make({})
      }),
    )

    const finishedAt = yield* Clock.currentTimeMillis
    const recorded = yield* Ref.get(turns)
    const cutRows = yield* Ref.get(cutShort)

    return yield* finalizeOutcome(
      input,
      termination,
      recorded,
      cutRows,
      Math.max(0, finishedAt - startedAt),
    )
  })

export const invoke = Effect.fn("Invocation.invoke")(function* <O>(
  input: InvokeInput<O>,
): Effect.fn.Return<AgentOutcome<O>, InvocationFailure, HarnessSessionFactory> {
  return yield* invokeInternal(input)
})

// Starts one invocation in the current scope and exposes the one scheduling
// fact Finder orchestration needs: whether its first response has streamed.
// Joining `outcome` never starts a second invocation.
export const invokeSignaled = Effect.fn("Invocation.invokeSignaled")(function* <O>(
  input: InvokeInput<O>,
): Effect.fn.Return<RunningInvocation<O>, never, HarnessSessionFactory | Scope.Scope> {
  const signal = yield* Deferred.make<PrefixSignal>()

  const fiber = yield* invokeInternal(input, signal).pipe(
    Effect.ensuring(Deferred.succeed(signal, PrefixSignal.PrefixNotObserved())),
    Effect.forkScoped,
  )

  return {
    firstResponse: Deferred.await(signal),
    outcome: Fiber.join(fiber),
  }
})
