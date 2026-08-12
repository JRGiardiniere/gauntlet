import {
  type AgentSessionEvent,
  createBashToolDefinition,
  createAgentSession,
  createReadToolDefinition,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  resolveCliModel,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import {
  type HarnessEvent,
  type HarnessSession,
  HarnessSessionFactory,
  type HarnessSessionFactoryShape,
  InvocationSetupError,
  type SessionConfig,
  StopReason,
  UsageRow,
} from "./harness-session.ts"
import { withToolCallDeadline } from "./tool-deadline.ts"

// The live Pi adapter: maps the real @earendil-works/pi-coding-agent session
// onto the HarnessSession seam. The whole point is that this file is a PURE
// mapping — construction, event renaming, and a raw usage sweep — with zero
// invocation logic. Deadlines, capture, salvage, and outcome assembly live
// above the seam and are identical under the scripted adapter.

// Every listed role is checked against Pi's message role vocabulary at the
// pinned version. `satisfies` fails the build if one stops being valid; it does
// not prove this list is exhaustive. The closed runtime decode still turns an
// unknown role into a contract_violation instead of silently dropping a
// message that might carry terminal state and usage.
type PiMessage = Extract<AgentSessionEvent, { type: "message_end" }>["message"]
const PI_MESSAGE_ROLES = [
  "user",
  "assistant",
  "toolResult",
  "bashExecution",
  "custom",
  "branchSummary",
  "compactionSummary",
] as const satisfies ReadonlyArray<PiMessage["role"]>

// Boundary decoders for the subset of Pi's event payloads the seam consumes.
// A renamed SDK field compiles clean and reads undefined through a cast —
// the drift that turned every cost into NaN once (#4 §8) — so the fields are
// decoded at runtime and failure surfaces as a contract_violation event.
const PiMessageRole = Schema.Struct({
  message: Schema.Struct({ role: Schema.Literals(PI_MESSAGE_ROLES) }),
})

const PiAssistantMessageEnd = Schema.Struct({
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    stopReason: StopReason,
    // Present-but-undefined on Pi's in-memory messages (this is not a JSON
    // boundary), so plain optionalKey would read healthy runs as drift.
    errorMessage: Schema.optional(Schema.String),
    usage: UsageRow,
  }),
})

const PiToolExecutionStart = Schema.Struct({
  toolName: Schema.String,
  args: Schema.Unknown,
})

const PiToolExecutionEnd = Schema.Struct({
  toolName: Schema.String,
  isError: Schema.Boolean,
  result: Schema.Struct({
    content: Schema.Array(
      Schema.Struct({
        type: Schema.String,
        text: Schema.optional(Schema.String),
      }),
    ),
  }),
})

const decodeMessageRole = Schema.decodeUnknownResult(PiMessageRole)
const decodeAssistantMessageEnd = Schema.decodeUnknownResult(
  PiAssistantMessageEnd,
)
const decodeToolExecutionStart = Schema.decodeUnknownResult(
  PiToolExecutionStart,
)
const decodeToolExecutionEnd = Schema.decodeUnknownResult(PiToolExecutionEnd)

const violation = (context: string, error: unknown): HarnessEvent => ({
  type: "contract_violation",
  reason: `${context}: ${String(error)}`,
})

// Rename the consumed Pi events into seam events; everything else is
// dropped. Events of a consumed type that no longer decode become
// contract_violation events — never a silent coercion. The parameter is Pi's
// own event union, so an SDK rename of a consumed type or field breaks the
// build here before it can drift at runtime.
const mapPiEvent = (event: AgentSessionEvent): HarnessEvent | undefined => {
  switch (event.type) {
    case "message_start": {
      return Result.match(decodeMessageRole(event), {
        onSuccess: (start) =>
          start.message.role === "assistant"
            ? ({ type: "message_start" } as const)
            : undefined,
        onFailure: (error) => violation("message_start did not decode", error),
      })
    }
    case "message_end": {
      const role = decodeMessageRole(event)
      if (Result.isSuccess(role) && role.success.message.role !== "assistant") {
        return undefined
      }
      return Result.match(decodeAssistantMessageEnd(event), {
        onSuccess: (end): HarnessEvent => ({
          type: "message_end",
          stopReason: end.message.stopReason,
          ...(end.message.errorMessage === undefined
            ? {}
            : { errorMessage: end.message.errorMessage }),
          usage: end.message.usage,
        }),
        onFailure: (error) =>
          violation("assistant message_end did not decode", error),
      })
    }
    case "tool_execution_start": {
      return Result.match(decodeToolExecutionStart(event), {
        onSuccess: (start): HarnessEvent => ({
          type: "tool_execution_start",
          toolName: start.toolName,
          args: start.args,
        }),
        onFailure: (error) =>
          violation("tool_execution_start did not decode", error),
      })
    }
    case "tool_execution_end": {
      return Result.match(decodeToolExecutionEnd(event), {
        onSuccess: (end): HarnessEvent => {
          const detail = end.result.content
            .flatMap((content) =>
              content.text === undefined ? [] : [content.text],
            )
            .join("\n")
          return {
            type: "tool_execution_end",
            toolName: end.toolName,
            isError: end.isError,
            ...(detail === "" ? {} : { detail }),
          }
        },
        onFailure: (error) =>
          violation("tool_execution_end did not decode", error),
      })
    }
    default: {
      return undefined
    }
  }
}

export const makeLivePiFactory = (): HarnessSessionFactoryShape => {
  // One ModelRuntime per factory: create() reloads the model catalog, config,
  // and credentials, so per-open recreation would make a fan-out of N lenses
  // pay N full initializations. A failed create is evicted rather than
  // cached, so a transient failure never poisons later opens.
  let runtimePromise: ReturnType<typeof ModelRuntime.create> | undefined
  const sharedModelRuntime = () => {
    if (runtimePromise === undefined) {
      const created = ModelRuntime.create()
      runtimePromise = created
      created.catch(() => {
        runtimePromise = undefined
      })
    }
    return runtimePromise
  }

  return {
    open: (session: SessionConfig) =>
      Effect.gen(function* () {
        // Deliberately zero-arg (no abort signal): the promise is shared
        // across opens, so one caller's interrupt must not cancel it.
        const modelRuntime = yield* Effect.tryPromise({
          try: () => sharedModelRuntime(),
          catch: (cause) =>
            new InvocationSetupError({
              operation: "model-runtime",
              reason: String(cause),
              cause,
            }),
        })

        // Split only the seat's provider separator. The model portion may
        // itself contain colons, so Pi's resolver owns model/thinking parsing.
        const providerSeparator = session.seat.indexOf("/")
        const provider = session.seat.slice(0, providerSeparator)
        const modelInput = session.seat.slice(providerSeparator + 1)
        const resolved = yield* Effect.try({
          try: () =>
            resolveCliModel({
              cliProvider: provider,
              cliModel: modelInput,
              modelRuntime,
            }),
          catch: (cause) =>
            new InvocationSetupError({
              operation: "resolve-model",
              reason: String(cause),
              cause,
            }),
        })
        const model = resolved.model
        if (!model) {
          const resolutionError = resolved.error?.replace(
            /Use --list-models to see available (?:providers\/models|models)\./,
            "Check the configured provider and model.",
          )
          return yield* new InvocationSetupError({
            operation: "resolve-model",
            reason:
              resolutionError ??
              `model not found: ${session.seat}`,
          })
        }
        if (resolved.warning !== undefined) {
          // Abnormal resolution — e.g. the pattern fell back to a custom
          // model id. Not fatal, but never silent.
          yield* Effect.logWarning(
            `model resolution warning: ${resolved.warning}`,
          )
        }

        return yield* Effect.tryPromise({
          try: async (signal): Promise<HarnessSession> => {
            // Retry ownership is ADR 0002, stated here rather than inherited
            // from Pi defaults: agent-level retry on (3 attempts),
            // provider-level 0 — provider retries above 0 can absorb quota
            // errors invisibly. Compaction off: it rewrites the shared
            // conversation prefix every fan-out agent's cache warmup paid
            // for; overflow surfaces honestly as a "length" stop instead.
            const settingsManager = SettingsManager.inMemory({
              transport: "sse",
              compaction: { enabled: false },
              retry: {
                enabled: true,
                maxRetries: 3,
                provider: { maxRetries: 0 },
              },
            })
            const resourceLoader = new DefaultResourceLoader({
              cwd: session.cwd,
              agentDir: getAgentDir(),
              settingsManager,
              noExtensions: true,
              noSkills: true,
              noContextFiles: true,
              noPromptTemplates: true,
              noThemes: true,
              systemPrompt: session.systemPrompt,
            })
            await resourceLoader.reload()

            // The cast on `parameters` is the documented plain-JSON-Schema
            // path: Pi detects the missing TypeBox.Kind symbol and runs its
            // JSON-Schema coercion pass instead (#4 §5). The cast is confined
            // to that one field so the SDK still type-checks every other.
            const emitToolDefinition: ToolDefinition = {
              name: session.emitTool.name,
              label: session.emitTool.name,
              description: session.emitTool.description,
              parameters: session.emitTool
                .parameters as unknown as ToolDefinition["parameters"],
              // Sequential execution closes the last-call-wins/terminate-
              // unanimity hazard: `terminate` only ends the run when every
              // finalized call in the batch terminates.
              executionMode: "sequential",
              execute: async (_toolCallId, args) => {
                session.emitTool.execute(args)
                return {
                  content: [{ type: "text" as const, text: "captured" }],
                  details: {},
                  terminate: true,
                }
              },
            }

            const customTools = [
              ...(session.tools.includes("read")
                ? [
                    withToolCallDeadline(
                      createReadToolDefinition(session.cwd),
                      session.toolTimeoutMillis,
                    ),
                  ]
                : []),
              ...(session.tools.includes("bash")
                ? [
                    withToolCallDeadline(
                      createBashToolDefinition(session.cwd),
                      session.bashTimeoutMillis,
                    ),
                  ]
                : []),
              withToolCallDeadline(
                emitToolDefinition,
                session.toolTimeoutMillis,
              ),
            ]

            const sessionManager = SessionManager.inMemory(
              session.cwd,
              session.sessionId === undefined
                ? undefined
                : { id: session.sessionId },
            )
            const created = await createAgentSession({
              cwd: session.cwd,
              model,
              modelRuntime,
              ...(resolved.thinkingLevel === undefined
                ? {}
                : { thinkingLevel: resolved.thinkingLevel }),
              noTools: "builtin",
              // The allowlist is HARD (#4 §5): a custom tool absent from it
              // is dropped before the model ever sees it.
              tools: [...session.tools, session.emitTool.name],
              // Pi's non-generic SDK option erases each definition's
              // parameter type. Keep the assertion at that one SDK seam;
              // every tool remains fully typed while it is built/wrapped.
              customTools: customTools as unknown as Array<ToolDefinition>,
              resourceLoader,
              sessionManager,
              settingsManager,
            })
            if (signal.aborted) {
              // The caller's deadline fired mid-construction. The interrupted
              // acquire will never hand this session to the release
              // finalizer, so dispose it here instead of leaking it.
              created.session.dispose()
              throw signal.reason
            }
            const agentSession = created.session

            return {
              subscribe: (listener) =>
                agentSession.subscribe((event) => {
                  const mapped = mapPiEvent(event)
                  if (mapped !== undefined) listener(mapped)
                }),
              prompt: (text) =>
                agentSession.prompt(text, {
                  expandPromptTemplates: false,
                  source: "rpc",
                }),
              abort: () => agentSession.abort(),
              dispose: () => {
                agentSession.dispose()
              },
              // Raw and verbatim; the bridge decodes rows against UsageRow
              // and a renamed field fails loudly there instead of reading
              // as $0.
              usageRows: () =>
                sessionManager.getEntries().flatMap((entry) =>
                  entry.type === "message" &&
                  entry.message.role === "assistant"
                    ? [entry.message.usage]
                    : [],
                ),
            } satisfies HarnessSession
          },
          catch: (cause) =>
            new InvocationSetupError({
              operation: "session-construction",
              reason: String(cause),
              cause,
            }),
        })
      }),
  }
}

export const livePiLayer = Layer.succeed(
  HarnessSessionFactory,
  makeLivePiFactory(),
)
