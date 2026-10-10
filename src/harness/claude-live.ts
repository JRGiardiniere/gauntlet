import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import {
  type HarnessEvent,
  type HarnessSession,
  type HarnessSessionFactoryContract,
  InvocationSetupError,
  type SessionConfig,
  type StopReason,
  type UsageRow,
} from "./harness-session.ts"

// The Claude Code Host's live adapter (#181): each AgentInvocation is a
// headless `claude -p` child of the running Claude Code, one process per turn,
// mapped onto the HarnessSession seam with no invocation logic (deadlines,
// corrective turns, capture and accounting stay in invoke.ts). The Mod's
// `$.process.spawn` takes stdin as one string and closes it, so a corrective
// turn is a second process that resumes the first one's session. Only the Mod
// provides this factory; the CLI's Runs execute on Pi (ADR-0009). Its mutable
// cells belong to the Promise and callback contract of HarnessSession.

export interface ClaudeLiveOptions {
  // The running Claude Code's own executable, as it tells its children
  // (CLAUDE_CODE_EXECPATH); undefined when it said nothing.
  readonly executable: string | undefined
  // The Run's directory once Submission made it: a disposed invocation's
  // Claude transcript moves into its transcripts/ folder.
  readonly runDirectory: () => string | undefined
}

// Claude Code adds this tool for --json-schema, its input_schema the contract.
const STRUCTURED_OUTPUT = "StructuredOutput"
const READ_TOOLS = "Read,Grep,Glob"
const STDERR_TAIL = 2_000

// Only the fields the adapter reads: extra fields are ignored, and a line
// that matches none of these shapes is skipped, so a Claude Code update
// cannot break a run by adding to its stream.
const Usage = Schema.Struct({
  input_tokens: Schema.Finite,
  output_tokens: Schema.Finite,
  cache_read_input_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  cache_creation_input_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
})

const SystemInit = Schema.Struct({
  type: Schema.Literal("system"),
  subtype: Schema.Literal("init"),
  session_id: Schema.String,
  memory_paths: Schema.Struct({ auto: Schema.String }),
})

const MessageStart = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: Schema.Struct({ type: Schema.Literal("message_start") }),
})

// The real stop reason and the response's usage; the `assistant` events carry
// neither.
const MessageDelta = Schema.Struct({
  type: Schema.Literal("stream_event"),
  event: Schema.Struct({
    type: Schema.Literal("message_delta"),
    delta: Schema.Struct({ stop_reason: Schema.NullOr(Schema.String) }),
    usage: Usage,
  }),
})

const Assistant = Schema.Struct({
  type: Schema.Literal("assistant"),
  message: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
})

const User = Schema.Struct({
  type: Schema.Literal("user"),
  message: Schema.Struct({ content: Schema.Array(Schema.Unknown) }),
})

const Result = Schema.Struct({
  type: Schema.Literal("result"),
  subtype: Schema.String,
  is_error: Schema.Boolean,
  total_cost_usd: Schema.Finite,
  result: Schema.optional(Schema.String),
  errors: Schema.optional(Schema.Array(Schema.String)),
  structured_output: Schema.optional(Schema.NullOr(Schema.Json)),
})

const ToolUse = Schema.Struct({
  type: Schema.Literal("tool_use"),
  id: Schema.String,
  name: Schema.String,
  input: Schema.Json,
})

const ToolResult = Schema.Struct({
  type: Schema.Literal("tool_result"),
  tool_use_id: Schema.String,
  is_error: Schema.optional(Schema.Boolean),
  content: Schema.optional(
    Schema.Union([Schema.String, Schema.Array(Schema.Struct({ text: Schema.optional(Schema.String) }))]),
  ),
})

const encodeJson = Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))
const Line = Schema.Union([SystemInit, MessageStart, MessageDelta, Assistant, User, Result])
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Line))
const decodeToolUse = Schema.decodeUnknownOption(ToolUse)
const decodeToolResult = Schema.decodeUnknownOption(ToolResult)
const isSystemInit = Schema.is(SystemInit)
const isMessageStart = Schema.is(MessageStart)
const isMessageDelta = Schema.is(MessageDelta)
const isAssistant = Schema.is(Assistant)
const isUser = Schema.is(User)

// Claude's stop reasons, mapped onto Pi's vocabulary that invoke.ts reads.
// A `refusal` ends the invocation as an error. `compaction` cannot arrive:
// the API answers it only to a request asking to pause after compaction,
// which Claude Code never sends.
const stopReasonOf = (claude: string | null): StopReason => {
  switch (claude) {
    case "end_turn":
    case "stop_sequence":
    case "pause_turn": {
      return "stop"
    }
    case "tool_use": {
      return "toolUse"
    }
    case "max_tokens":
    case "model_context_window_exceeded": {
      return "length"
    }
    default: {
      return "error"
    }
  }
}

const zeroUsage = (): UsageRow => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } })

// "claude-code/sonnet:low" → model "sonnet", effort "low".
const seatParts = (seat: string) => {
  const rest = seat.slice(seat.indexOf("/") + 1)
  const colon = rest.lastIndexOf(":")
  return { model: rest.slice(0, colon), effort: rest.slice(colon + 1) }
}

const toolResultText = (content: typeof ToolResult.Type["content"]) =>
  content === undefined || Predicate.isString(content)
    ? content
    : content.flatMap((part) => (part.text === undefined ? [] : [part.text])).join("\n")

// One turn: its process's fiber, and whether its result arrived.
interface Turn {
  readonly fiber: Fiber.Fiber<void>
  readonly state: { resulted: boolean }
}

export const makeClaudeLiveFactory = (options: ClaudeLiveOptions) =>
  Effect.gen(function* () {
    const platform = yield* Effect.context<ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path>()
    const spawner = Context.get(platform, ChildProcessSpawner.ChildProcessSpawner)
    const fs = Context.get(platform, FileSystem.FileSystem)
    const path = Context.get(platform, Path.Path)

    const open = (config: SessionConfig) =>
      Effect.gen(function* () {
        const executable = options.executable
        if (executable === undefined) {
          return yield* new InvocationSetupError({
            operation: "open",
            reason: "the running Claude Code did not say where its executable is (CLAUDE_CODE_EXECPATH)",
          })
        }
        // The opening fiber's services, so the bridge logs to the Run's
        // run.log, with the platform the factory was built over.
        const services = Context.merge(yield* Effect.context<never>(), platform)
        const run = Effect.runForkWith(services)
        const sessionId = globalThis.crypto.randomUUID()
        // The snapshot is the worktree folder of the Run's temp area, which
        // the Run removes as it ends.
        const systemPromptFile = path.join(path.dirname(config.cwd), `claude-system-${sessionId}.md`)
        yield* fs.writeFileString(systemPromptFile, config.systemPrompt).pipe(
          Effect.mapError((cause) => new InvocationSetupError({ operation: "open", reason: String(cause), cause })),
        )
        const { effort, model } = seatParts(config.seat)
        // The contract's projection, its description the tool's own text.
        const schema = yield* encodeJson({ ...config.emitTool.parameters, description: config.emitTool.description }).pipe(
          Effect.mapError((cause) => new InvocationSetupError({ operation: "open", reason: String(cause), cause })),
        )
        // Every turn passes the same argv, but for how it names the session:
        // a resumed turn keeps the system prompt and model and nothing else
        // (tools, permission flags, setting sources, the schema).
        const argv = (turn: number) => [
          "-p",
          "--model",
          model,
          "--effort",
          effort,
          "--system-prompt-file",
          systemPromptFile,
          "--tools",
          config.tools.length === 0 ? "" : READ_TOOLS,
          // Pinned: with telemetry off an unpinned child starts in auto mode.
          // Under `default` with no prompts, a read outside the cwd (the
          // snapshot) is refused and the model told not to retry.
          "--permission-mode",
          "default",
          "--permission-prompts",
          "none",
          "--setting-sources",
          "",
          "--strict-mcp-config",
          "--json-schema",
          schema,
          "--output-format",
          "stream-json",
          "--verbose",
          "--include-partial-messages",
          ...(turn === 0 ? ["--session-id", sessionId] : ["--resume", sessionId]),
        ]

        const listeners = new Set<(event: HarnessEvent) => void>()
        const usageRows: Array<UsageRow> = []
        const transcript: Array<HarnessEvent> = []
        const toolNames = new Map<string, string>()
        let claudeTranscript: { readonly projects: string; readonly file: string } | undefined
        let turns = 0
        let current: Turn | undefined
        let abortRequested = false
        let disposed = false

        const dispatch = (event: HarnessEvent) => {
          transcript.push(event)
          for (const listener of listeners) listener(event)
        }
        // A tool's name as invoke.ts knows it: the emit tool by the
        // contract's own name.
        const toolNameOf = (name: string) => (name === STRUCTURED_OUTPUT ? config.emitTool.name : name)

        const runTurn = (text: string, turn: number, state: Turn["state"], settle: () => void) => {
          // How the turn's last response stopped, and the row it was counted
          // on, which takes the turn's cost from its result.
          let lastStop: StopReason | undefined
          let lastRow: number | undefined
          const failed = (errorMessage: string, cost = 0) => {
            usageRows.push({ ...zeroUsage(), cost: { total: cost } })
            dispatch({ type: "message_end", stopReason: "error", usage: zeroUsage(), errorMessage })
          }
          const onResult = (result: typeof Result.Type) => {
            const row = lastRow === undefined ? undefined : usageRows[lastRow]
            if (lastRow !== undefined && row !== undefined) {
              usageRows[lastRow] = { ...row, cost: { total: result.total_cost_usd } }
            }
            // A valid StructuredOutput call ends the turn, its object in the
            // result; the strict decode stays authoritative over Claude
            // Code's own validator.
            const output = result.structured_output
            if (output !== undefined && output !== null) {
              const rejection = config.emitTool.check(output)
              if (rejection === undefined) config.emitTool.execute(output)
              else dispatch({ type: "tool_execution_end", toolName: config.emitTool.name, isError: true, detail: rejection })
            }
            // An error result is terminal evidence only when the turn's last
            // response did not already end it: Claude Code ends a turn as an
            // error result after the max_tokens responses it gave up retrying.
            // Running out of structured-output retries is a missing emit,
            // which gets invoke.ts's corrective turn. A result after no
            // response at all is an error too, so the invocation fails alone
            // rather than settling with no evidence.
            const endedByResponse = lastStop === "length" || lastStop === "error"
            const cost = lastRow === undefined ? result.total_cost_usd : 0
            if (result.is_error && result.subtype !== "error_max_structured_output_retries" && !endedByResponse) {
              failed(result.result ?? result.errors?.join("; ") ?? `Claude Code turn ended: ${result.subtype}`, cost)
            } else if (lastStop === undefined) {
              failed("Claude Code turn ended with no recorded response", cost)
            }
          }
          const onMessageDelta = (delta: typeof MessageDelta.Type["event"]) => {
            const row: UsageRow = {
              input: delta.usage.input_tokens,
              output: delta.usage.output_tokens,
              cacheRead: delta.usage.cache_read_input_tokens ?? 0,
              cacheWrite: delta.usage.cache_creation_input_tokens ?? 0,
              cost: { total: 0 },
            }
            usageRows.push(row)
            lastRow = usageRows.length - 1
            const claude = delta.delta.stop_reason
            const stopReason = stopReasonOf(claude)
            lastStop = stopReason
            dispatch(
              stopReason === "error"
                ? { type: "message_end", stopReason, usage: row, errorMessage: `Claude stop reason ${String(claude)}` }
                : { type: "message_end", stopReason, usage: row },
            )
          }
          const onLine = (raw: string) => {
            const line = Option.getOrUndefined(decodeLine(raw))
            if (line === undefined) return
            if (isSystemInit(line)) {
              claudeTranscript = { projects: path.dirname(path.dirname(line.memory_paths.auto)), file: `${line.session_id}.jsonl` }
            } else if (isMessageStart(line)) {
              dispatch({ type: "message_start" })
            } else if (isMessageDelta(line)) {
              onMessageDelta(line.event)
            } else if (isAssistant(line)) {
              for (const block of line.message.content) {
                const use = Option.getOrUndefined(decodeToolUse(block))
                if (use === undefined) continue
                toolNames.set(use.id, use.name)
                dispatch({ type: "tool_execution_start", toolName: toolNameOf(use.name), args: use.input })
              }
            } else if (isUser(line)) {
              for (const block of line.message.content) {
                const ended = Option.getOrUndefined(decodeToolResult(block))
                if (ended === undefined) continue
                const toolName = toolNameOf(toolNames.get(ended.tool_use_id) ?? "unknown")
                const isError = ended.is_error === true
                const detail = isError ? toolResultText(ended.content) : undefined
                dispatch(
                  detail === undefined
                    ? { type: "tool_execution_end", toolName, isError }
                    : { type: "tool_execution_end", toolName, isError, detail },
                )
              }
            } else {
              onResult(line)
              state.resulted = true
              settle()
            }
          }
          return Effect.scoped(
            Effect.gen(function* () {
              const handle = yield* spawner.spawn(
                ChildProcess.make(executable, argv(turn), {
                  cwd: config.cwd,
                  extendEnv: true,
                  // No plugins, no reload watch, and a faster exit; never
                  // CLAUDE_CODE_CHILD_SESSION, which stops session saving and
                  // so breaks --resume.
                  env: {
                    CLAUDE_CODE_PLUGIN_DIRS: "",
                    CLAUDE_CODE_PLUGIN_DIR_WATCH: "",
                    DISABLE_TELEMETRY: "1",
                    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
                    CLAUDE_CODE_CHILD_SESSION: undefined,
                  },
                  stdin: Stream.make(new TextEncoder().encode(text)),
                }),
              )
              const stderr = yield* Effect.forkScoped(Stream.mkString(Stream.decodeText(handle.stderr)))
              yield* Stream.runForEach(Stream.splitLines(Stream.decodeText(handle.stdout)), (raw) =>
                Effect.sync(() => onLine(raw)))
              const exit = yield* Effect.exit(handle.exitCode)
              const errorText = (yield* Fiber.join(stderr)).trim().slice(-STDERR_TAIL)
              if (state.resulted || abortRequested) return
              // No result: the partial response is lost with the process.
              if (Exit.isFailure(exit)) {
                dispatch({ type: "interrupted", reason: "the claude -p child was ended by a signal the run did not send" })
              } else {
                failed(`claude -p exited with code ${String(exit.value)} before its result${errorText === "" ? "" : `: ${errorText}`}`)
              }
            }),
          ).pipe(
            Effect.catch((error) => Effect.sync(() => failed(`claude -p could not run: ${String(error)}`))),
            Effect.ensuring(Effect.sync(settle)),
          )
        }

        // The previous turn's process finishes writing its transcript before
        // the next one resumes it, or before the transcript moves.
        const settled = () => (current === undefined ? Effect.void : Effect.asVoid(Fiber.await(current.fiber)))

        // The child's transcript is `<session_id>.jsonl` in one of Claude
        // Code's project folders, the folder init's auto-memory path sits two
        // levels under. Which one is the cwd's, unless the cwd is a git
        // worktree (a snapshot always is), whose auto memory is its main
        // repository's; so it is found by its name rather than by spelling
        // Claude Code's path encoding.
        const moveTranscript = Effect.gen(function* () {
          const runDirectory = options.runDirectory()
          if (claudeTranscript === undefined || runDirectory === undefined) return
          const { file, projects } = claudeTranscript
          let found: string | undefined
          for (const project of yield* fs.readDirectory(projects)) {
            const candidate = path.join(projects, project, file)
            if (yield* fs.exists(candidate)) {
              found = candidate
              break
            }
          }
          if (found === undefined) return yield* Effect.logWarning(`Claude transcript ${file} for ${config.invocationId} not found under ${projects}`)
          const folder = path.join(runDirectory, "transcripts")
          yield* fs.makeDirectory(folder, { recursive: true })
          yield* fs.rename(found, path.join(folder, `${config.invocationId}.${sessionId}.jsonl`))
        }).pipe(
          Effect.catch((error) => Effect.logWarning(`Claude transcript for ${config.invocationId} not moved: ${String(error)}`)),
        )

        const session: HarnessSession = {
          subscribe: (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          },
          prompt: (text) =>
            // @effect-diagnostics-next-line newPromise:off
            new Promise<void>((resolve) => {
              const turn = turns
              turns += 1
              const state = { resulted: false }
              const previous = settled()
              current = { fiber: run(Effect.andThen(previous, runTurn(text, turn, state, resolve))), state }
            }),
          // Killing the child ends the turn: it reports no result, and the
          // spend of its unfinished turn is lost with it.
          abort: () => {
            abortRequested = true
            const turn = current
            if (turn === undefined || turn.state.resulted) return Promise.resolve()
            return Effect.runPromiseWith(services)(Fiber.interrupt(turn.fiber))
          },
          dispose: () => {
            if (disposed) return
            disposed = true
            const turn = current
            const ended = turn === undefined || turn.state.resulted ? settled() : Fiber.interrupt(turn.fiber)
            run(Effect.andThen(ended, moveTranscript))
          },
          usageRows: () => usageRows,
          transcriptEntries: () => transcript,
        }
        return session
      })

    return {
      open,
      // Claude Code's own filesystem tools see the snapshot path itself.
      workspaceRoot: (snapshot: string) => snapshot,
      workspacePrompt: "workspace-claude-code.md",
      // Each contract is the --json-schema of Claude Code's StructuredOutput
      // tool, which is the name the model sees.
      emitToolName: () => STRUCTURED_OUTPUT,
    } satisfies HarnessSessionFactoryContract
  })
