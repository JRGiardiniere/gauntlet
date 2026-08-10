import {
  createAgentSession,
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
  RawUsage,
  type SessionConfig,
  SessionOpenError,
  StopReason,
} from "./harness-session.ts"

// The live Pi adapter: maps the real @earendil-works/pi-coding-agent session
// onto the HarnessSession seam. The whole point is that this file is a PURE
// mapping — construction, event renaming, and a raw usage sweep — with zero
// invocation logic. Deadlines, capture, salvage, and outcome assembly live
// above the seam and are identical under the scripted adapter.

export interface LivePiConfig {
  readonly provider: string
  // May carry a thinking level: "gpt-5.6-luna:low". Resolved by Pi's own
  // resolver, never hand-parsed — model ids contain colons (#4 §6).
  readonly model: string
  readonly cwd: string
}

// Boundary decoders for the subset of Pi's event payloads the seam consumes.
// A renamed SDK field compiles clean and reads undefined through a cast —
// the drift that turned every cost into NaN once (#4 §8) — so the fields are
// decoded at runtime and failure surfaces as a contract_violation event.
const PiMessageRole = Schema.Struct({
  message: Schema.Struct({ role: Schema.String }),
})

const PiAssistantMessageEnd = Schema.Struct({
  message: Schema.Struct({
    role: Schema.Literal("assistant"),
    stopReason: StopReason,
    // Present-but-undefined on Pi's in-memory messages (this is not a JSON
    // boundary), so plain optionalKey would read healthy runs as drift.
    errorMessage: Schema.optional(Schema.String),
    usage: RawUsage,
  }),
})

const PiToolExecutionStart = Schema.Struct({
  toolName: Schema.String,
  args: Schema.Unknown,
})

const decodeMessageRole = Schema.decodeUnknownResult(PiMessageRole)
const decodeAssistantMessageEnd = Schema.decodeUnknownResult(
  PiAssistantMessageEnd,
)
const decodeToolExecutionStart = Schema.decodeUnknownResult(
  PiToolExecutionStart,
)

const violation = (context: string, error: unknown): HarnessEvent => ({
  type: "contract_violation",
  reason: `${context}: ${String(error)}`,
})

// Rename the three consumed Pi events into seam events; everything else is
// dropped. Events of a consumed type that no longer decode become
// contract_violation events — never a silent coercion.
const mapPiEvent = (event: { readonly type: string }): HarnessEvent | undefined => {
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
    default: {
      return undefined
    }
  }
}

export const makeLivePiFactory = (
  config: LivePiConfig,
): HarnessSessionFactoryShape => ({
  open: (session: SessionConfig) =>
    Effect.gen(function* () {
      const openFailed = (cause: unknown) =>
        new SessionOpenError({ reason: String(cause) })

      // Model resolution first, via Pi's own resolver — model ids contain
      // colons, so `pattern:level` must be tried as a whole id before any
      // colon splitting; a re-implementation rejects strings Pi accepts.
      const { modelRuntime, resolved } = yield* Effect.tryPromise({
        try: async () => {
          const runtime = await ModelRuntime.create()
          return {
            modelRuntime: runtime,
            resolved: resolveCliModel({
              cliProvider: config.provider,
              cliModel: config.model,
              modelRuntime: runtime,
            }),
          }
        },
        catch: openFailed,
      })
      const model = resolved.model
      if (!model) {
        return yield* new SessionOpenError({
          reason:
            resolved.error ?? `model not found: ${config.provider}/${config.model}`,
        })
      }

      return yield* Effect.tryPromise({
        try: async (): Promise<HarnessSession> => {
          // Retry ownership is ADR 0002, stated here rather than inherited from
          // Pi defaults: agent-level retry on (3 attempts), provider-level 0 —
          // provider retries above 0 can absorb quota errors invisibly.
          // Compaction off: it rewrites the shared conversation prefix every
          // fan-out agent's cache warmup paid for; overflow surfaces honestly
          // as a "length" stop instead.
          const settingsManager = SettingsManager.inMemory({
            transport: "sse",
            compaction: { enabled: false },
            retry: { enabled: true, maxRetries: 3, provider: { maxRetries: 0 } },
          })
          const resourceLoader = new DefaultResourceLoader({
            cwd: config.cwd,
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

          // The cast on `parameters` is the documented plain-JSON-Schema path:
          // Pi detects the missing TypeBox.Kind symbol and runs its JSON-Schema
          // coercion pass instead (#4 §5). Sequential execution closes the
          // last-call-wins/terminate-unanimity hazard: `terminate` only ends
          // the run when every finalized call in the batch terminates.
          const emitToolDefinition = {
            name: session.emitTool.name,
            label: session.emitTool.name,
            description: session.emitTool.description,
            parameters: session.emitTool
              .parameters as unknown as ToolDefinition["parameters"],
            executionMode: "sequential",
            execute: async (_toolCallId: string, args: unknown) => {
              session.emitTool.execute(args)
              return {
                content: [{ type: "text" as const, text: "captured" }],
                details: {},
                terminate: true,
              }
            },
          } as unknown as ToolDefinition

          const sessionManager = SessionManager.inMemory(
            config.cwd,
            session.sessionId === undefined ? undefined : { id: session.sessionId },
          )
          const created = await createAgentSession({
            cwd: config.cwd,
            model,
            modelRuntime,
            ...(resolved.thinkingLevel === undefined
              ? {}
              : { thinkingLevel: resolved.thinkingLevel }),
            noTools: "builtin",
            // The allowlist is HARD (#4 §5): a custom tool absent from it is
            // dropped before the model ever sees it.
            tools: [session.emitTool.name],
            customTools: [emitToolDefinition],
            resourceLoader,
            sessionManager,
            settingsManager,
          })
          const agentSession = created.session

          return {
            subscribe: (listener) =>
              agentSession.subscribe((event) => {
                const mapped = mapPiEvent(event)
                if (mapped !== undefined) listener(mapped)
              }),
            prompt: (text) => agentSession.prompt(text),
            abort: () => agentSession.abort(),
            dispose: () => {
              agentSession.dispose()
            },
            // Raw and verbatim; the bridge decodes rows against RawUsage and a
            // renamed field fails loudly there instead of reading as $0.
            usageRows: () =>
              agentSession.messages
                .filter((message) => message.role === "assistant")
                .map((message): unknown => message.usage),
          } satisfies HarnessSession
        },
        catch: openFailed,
      })
    }),
})

export const livePiLayer = (config: LivePiConfig) =>
  Layer.succeed(HarnessSessionFactory, makeLivePiFactory(config))
