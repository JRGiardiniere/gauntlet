import type { ToolDefinition } from "@earendil-works/pi-coding-agent"
import * as Data from "effect/Data"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"

export class ToolCallTimeoutError extends Data.TaggedError(
  "ToolCallTimeoutError",
)<{
  readonly toolName: string
  readonly timeoutMillis: number
  readonly message: string
}> {}

class ToolCallExecutionError extends Data.TaggedError(
  "ToolCallExecutionError",
)<{
  readonly toolName: string
  readonly message: string
  readonly cause: unknown
}> {}

// Pi requires a Promise-returning method, so this adapter runs one bounded
// Effect at that literal Promise seam. Effect owns the timer and interrupts
// the tryPromise signal before the named timeout failure is exposed; tools
// that reject on abort cannot replace it with a generic "Operation aborted".
type ToolParameters = ToolDefinition["parameters"]

export const withToolCallDeadline = <
  Parameters extends ToolParameters,
  Details,
  State,
>(
  tool: ToolDefinition<Parameters, Details, State>,
  timeoutMillis: number,
): ToolDefinition<Parameters, Details, State> => {
  const originalExecute = tool.execute.bind(tool)
  const execute: ToolDefinition<Parameters, Details, State>["execute"] = (
    toolCallId,
    params,
    parentSignal,
    onUpdate,
    context,
  ) =>
    Effect.tryPromise({
      try: (timeoutSignal) =>
        originalExecute(
          toolCallId,
          params,
          parentSignal === undefined
            ? timeoutSignal
            : AbortSignal.any([parentSignal, timeoutSignal]),
          onUpdate,
          context,
        ),
      catch: (cause) =>
        new ToolCallExecutionError({
          toolName: tool.name,
          message: `${tool.name} failed: ${String(cause)}`,
          cause,
        }),
    }).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(timeoutMillis),
        orElse: () =>
          Effect.fail(
            new ToolCallTimeoutError({
              toolName: tool.name,
              timeoutMillis,
              message: `${tool.name} exceeded its ${String(timeoutMillis)}ms deadline`,
            }),
          ),
      }),
      Effect.runPromise,
    )

  return { ...tool, execute }
}
