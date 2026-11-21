import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { FileAccess } from "@opencode/core/file-access"
import { Plugin } from "@opencode/plugin/effect"
import { AbsolutePath, Agent, Model, type OpenCode, Provider, type Session, Tool } from "@opencode/sdk/effect"
import * as Array from "effect/Array"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as LogLevel from "effect/LogLevel"
import * as Option from "effect/Option"
import type * as Path from "effect/Path"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { AgentToolCalls } from "../domain/agent-outcome.ts"
import { DEPENDENCIES } from "../run/installed-dependencies.ts"
import { scrubbedGitEnv } from "../target/git.ts"
import {
  AdapterContractViolation,
  type AgentSpec,
  type HarnessSession,
  type InspectionTool,
  TurnEnd,
  type TurnResult,
  type UsageRow,
} from "../harness/harness-session.ts"
import { HostError } from "./host.ts"
import { toModelRef } from "./model-ref.ts"

// AgentInvocations on the embedded Host: the Gauntlet plugin that holds the
// Host-side policy, and the sessions an invocation drives through it.

export const GAUNTLET_PLUGIN_ID = "gauntlet"

// Bounds the wait for a Run's Location to activate the plugin and list the
// Seat's model, so a stuck plugin fails the invocation instead of hanging it.
const AGENT_READY_TIMEOUT = Duration.seconds(60)

// Bounds paging through a session's assistant messages.
const MESSAGE_PAGE = 200

// OpenCode's Code Mode instruction key; kept on OpenAI requests while date and
// environment builtins are stripped so the cached prefix stays stable.
const CODEMODE_INSTRUCTION_KEY = "core/codemode"

interface AgentDefinition {
  readonly system: string
  readonly tools: ReadonlyArray<InspectionTool>
  readonly emit: string
}

interface EmitDefinition {
  readonly description: string
  readonly parameters: AgentSpec["emit"]["parameters"]
}

// One logical turn's idle-to-wake lifecycle for detached Code Mode and shell
// jobs. Owns both the waiter deferred and the set of detached jobs whose
// synthetic results have not yet entered context, so a job that finishes right
// before `experimental.idle` or wakes before `awaitNextWake` cannot strand or
// prematurely end the turn.
export interface TurnLifecycle {
  readonly resetWaiter: () => void
  readonly trackDetached: (jobID: string) => void
  readonly markDelivered: (jobID: string) => void
  readonly onIdle: (hasRunningBackground: boolean) => void
  readonly onExecutionStarted: Effect.Effect<void>
  readonly awaitNextWake: Effect.Effect<boolean>
}

export const makeTurnLifecycle = (): TurnLifecycle => {
  const detached = new Set<string>()
  let waiter: Deferred.Deferred<void> | undefined

  return {
    resetWaiter: () => {
      waiter = undefined
    },
    trackDetached: (jobID) => {
      detached.add(jobID)
    },
    markDelivered: (jobID) => {
      detached.delete(jobID)
    },
    onIdle: (hasRunningBackground) => {
      if ((hasRunningBackground || detached.size > 0) && waiter === undefined) {
        waiter = Deferred.makeUnsafe<void>()
      }
    },
    onExecutionStarted: Effect.suspend(() =>
      waiter === undefined ? Effect.void : Deferred.succeed(waiter, undefined).pipe(Effect.asVoid)),
    awaitNextWake: Effect.suspend(() => {
      const pending = waiter

      if (pending === undefined) return Effect.succeed(false)

      return Deferred.await(pending).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            if (waiter === pending) waiter = undefined
          }),
        ),
        Effect.as(true),
      )
    }),
  }
}

interface RecordedToolCall {
  readonly errored: boolean
  readonly path?: string
}

// What the plugin knows about one open session.
interface SessionRoute {
  readonly workspace: string
  readonly emit: AgentSpec["emit"]
  readonly cacheGroup: string | undefined
  readonly firstToken: Deferred.Deferred<void>
  readonly lifecycle: TurnLifecycle
  // Tool outcomes recorded inside this turn (covers both foreground and
  // detached Code Mode inner calls, plus script-level errors with no inner calls).
  turnCalls: Array<RecordedToolCall>
  // The first emit that passed the strict decoder; once set, the session
  // sends no further model request.
  emitted: Schema.Json | undefined
  rejections: Array<string>
}

// State shared between the plugin's hooks and the sessions, one per Host.
// Hooks and tool callbacks are OpenCode's, so these cells are plain maps.
interface Registry {
  readonly agents: Map<string, Map<string, AgentDefinition>>
  readonly emitTools: Map<string, EmitDefinition>
  readonly contexts: Map<string, Plugin.Context>
  readonly sessions: Map<string, SessionRoute>
}

export const makeRegistry = (): Registry => ({
  agents: new Map(),
  emitTools: new Map(),
  contexts: new Map(),
  sessions: new Map(),
})

// Last match wins: everything denied, so nothing falls through to asking
// (including edits, writes, and web fetches); then the tools the Stage uses
// and its own emit tool; then anything outside the snapshot as written, denied
// again over those allows. Pool, with no inspection tools, sees its emit tool
// only.
export const permissionsFor = (definition: Pick<AgentDefinition, "tools" | "emit">) => [
  { action: "*", resource: "*", effect: "deny" as const },
  ...Array.map(definition.tools, (tool) => ({ action: tool, resource: "*", effect: "allow" as const })),
  { action: definition.emit, resource: "*", effect: "allow" as const },
  { action: "external_directory", resource: "*", effect: "deny" as const },
]

// The filesystem services the plugin's tool wrappers use; it runs inside
// OpenCode, so Gauntlet hands these over when it boots the Host.
export interface PluginServices {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
}

const PathInput = Schema.Struct({ path: Schema.optionalKey(Schema.String) })

const decodePathInput = Schema.decodeUnknownOption(PathInput)

const ShellInput = Schema.Struct({
  command: Schema.optionalKey(Schema.String),
  workdir: Schema.optionalKey(Schema.String),
})

const decodeShellInput = Schema.decodeUnknownOption(ShellInput)

const ShellOutput = Schema.Struct({
  exitCode: Schema.Finite.pipe(Schema.NullOr, Schema.optionalKey),
  signal: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
})

const decodeShellOutput = Schema.decodeUnknownOption(ShellOutput)

const DetachedMetadata = Schema.Struct({
  jobID: Schema.optionalKey(Schema.String),
  shellID: Schema.optionalKey(Schema.String),
})

const decodeDetachedMetadata = Schema.decodeUnknownOption(DetachedMetadata)

const ExecuteAfterMetadata = Schema.Struct({
  jobID: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.Boolean),
  toolCalls: Schema.Struct({ status: Schema.String }).pipe(Schema.Array, Schema.optionalKey),
})

const decodeExecuteAfterMetadata = Schema.decodeUnknownOption(ExecuteAfterMetadata)

// A tool call's path relative to the snapshot at `root`, resolved as the tool
// resolves it (`~`, `..`, absolute) without following links; undefined when
// it leaves the snapshot, which OpenCode's `external_directory` rule refuses.
const relativeAsWritten = (path: Path.Path, root: string, input: string) => {
  const relative = path.relative(root, FileAccess.resolvePath(root, input))

  return relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) ? undefined : relative
}

const segmentsAsWritten = (path: Path.Path, root: string, input: string) =>
  relativeAsWritten(path, root, input)?.split(path.sep) ?? []

const normalizePath = (path: Path.Path, workspace: string, raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const relative = relativeAsWritten(path, workspace, raw)

  return relative === undefined ? raw : relative === "" ? "." : relative
}

type Execute = Tool.Info["execute"]

const missingDependenciesError = (given: string) =>
  Tool.Error.make({
    message: `Unavailable: dependencies were not installed in the caller's checkout, so ${given} is not available to this review.`,
  })

const checkInstalledPath = ({ fs, path }: PluginServices, root: string, given: string) => {
  const segments = segmentsAsWritten(path, root, given)
  const index = segments.indexOf(DEPENDENCIES)

  if (index < 0) return Effect.succeed(true)

  return fs.exists(path.join(root, ...segments.slice(0, index + 1))).pipe(Effect.orElseSucceed(() => false))
}

// A read call naming a path under a `node_modules` the snapshot lacks fails
// with why: the Caller's checkout had none installed there.
const requiringInstalled = (services: PluginServices, root: string, execute: Execute): Execute =>
  (input, context) => {
    const given = Option.match(decodePathInput(input), { onNone: () => ".", onSome: (fields) => fields.path ?? "." })

    return checkInstalledPath(services, root, given).pipe(
      Effect.flatMap((installed) => (installed ? execute(input, context) : Effect.fail(missingDependenciesError(given)))),
    )
  }

// Extracts the first token in a shell command referencing `node_modules`, if any.
const dependencyTokenInCommand = (command: string | undefined): string | undefined =>
  command?.match(/(?:^|[\s"'=:(])([^\s"'=;:()|&]*\bnode_modules(?:\/[^\s"'=;:()|&]*)?)/)?.[1]

// A shell call targeting a missing `node_modules` (via `workdir` or command
// argument) fails with the same caller-install explanation as `read`.
const requiringInstalledShell = (services: PluginServices, root: string, execute: Execute): Execute =>
  (input, context) => {
    const parsed = decodeShellInput(input)
    const workdir = Option.match(parsed, { onNone: () => undefined, onSome: (fields) => fields.workdir })
    const command = Option.match(parsed, { onNone: () => undefined, onSome: (fields) => fields.command })

    if (workdir !== undefined) {
      const segments = segmentsAsWritten(services.path, root, workdir)

      if (segments.includes(DEPENDENCIES)) {
        return checkInstalledPath(services, root, workdir).pipe(
          Effect.flatMap((installed) => (installed ? execute(input, context) : Effect.fail(missingDependenciesError(workdir)))),
        )
      }
    }

    const token = dependencyTokenInCommand(command)

    if (token === undefined) return execute(input, context)
    const base = workdir ?? "."
    const target = services.path.join(base, token)

    return Effect.zipWith(
      checkInstalledPath(services, root, target),
      services.fs.exists(services.path.join(root, DEPENDENCIES)).pipe(Effect.orElseSucceed(() => false)),
      (underBase, atRoot) => underBase || atRoot,
    ).pipe(
      Effect.flatMap((installed) => (installed ? execute(input, context) : Effect.fail(missingDependenciesError(token)))),
    )
  }

const WRAPPED_TOOLS: ReadonlySet<string> = new Set(["read", "shell", "grep", "glob"])

// Records each read/grep/glob invocation for turn tool-health accounting,
// whether called directly or inside a foreground/detached Code Mode script.
const observingPathTool = (registry: Registry, path: Path.Path, execute: Execute): Execute =>
  (input, context) => {
    const rawPath = Option.match(decodePathInput(input), { onNone: () => undefined, onSome: (fields) => fields.path })

    return execute(input, context).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          registry.sessions.get(context.sessionID)?.turnCalls.push({ errored: false })
        })),
      Effect.tapError(() =>
        Effect.sync(() => {
          const route = registry.sessions.get(context.sessionID)

          if (route === undefined) return
          const normalized = normalizePath(path, route.workspace, rawPath)
          route.turnCalls.push(normalized === undefined ? { errored: true } : { errored: true, path: normalized })
        })),
    )
  }

// Records each shell invocation for turn tool-health accounting: exit code 0
// and 1 (normal "no match" for rg/grep or failing test probe) count as healthy;
// exit code >= 2 (command not found, bad syntax, git fatal) or a signal or
// thrown Tool.Error counts as errored.
const observingShellTool = (registry: Registry, path: Path.Path, execute: Execute): Execute =>
  (input, context) => {
    const rawWorkdir = Option.match(decodeShellInput(input), { onNone: () => undefined, onSome: (fields) => fields.workdir })

    return execute(input, context).pipe(
      Effect.tap((result) =>
        Effect.sync(() => {
          const route = registry.sessions.get(context.sessionID)

          if (route === undefined) return
          const parsed = decodeShellOutput(result.output)

          if (Option.isSome(parsed) && parsed.value.shellID !== undefined) {
            route.lifecycle.trackDetached(parsed.value.shellID)
          }

          const failed = Option.isSome(parsed) && (
            parsed.value.signal !== undefined ||
            (parsed.value.exitCode !== undefined && parsed.value.exitCode !== null && parsed.value.exitCode >= 2)
          )

          if (!failed) {
            route.turnCalls.push({ errored: false })

            return
          }

          const normalized = normalizePath(path, route.workspace, rawWorkdir)
          route.turnCalls.push(normalized === undefined ? { errored: true } : { errored: true, path: normalized })
        })),
      Effect.tapError(() =>
        Effect.sync(() => {
          const route = registry.sessions.get(context.sessionID)

          if (route === undefined) return
          const normalized = normalizePath(path, route.workspace, rawWorkdir)
          route.turnCalls.push(normalized === undefined ? { errored: true } : { errored: true, path: normalized })
        })),
    )
  }

const agentID = (role: string) => `gauntlet-${role}`

const decodeEmitArguments = Schema.decodeUnknownOption(Schema.Json)

const emitExecute = (registry: Registry, name: string) =>
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- OpenCode hands a tool its arguments untyped; they are parsed as JSON, then by the strict decoder
  (input: unknown, context: Tool.Context) =>
    Effect.suspend(() => {
      const route = registry.sessions.get(context.sessionID)

      if (route === undefined || route.emit.name !== name) {
        return Effect.fail(Tool.Error.make({ message: `${name} is not this session's emit tool` }))
      }

      const raw = decodeEmitArguments(input)
      const rejection = Option.match(raw, { onNone: () => "the arguments are not JSON", onSome: route.emit.check })

      if (rejection !== undefined || Option.isNone(raw)) {
        route.rejections.push(`${name} rejected: ${rejection ?? "the arguments are not JSON"}`)

        return Effect.fail(Tool.Error.make({ message: `${name} arguments are invalid: ${rejection ?? ""}. Fix them and call ${name} again.` }))
      }

      route.emitted ??= raw.value

      return Effect.succeed({ content: "Recorded." })
    })

// OpenAI's prompt cache key, wherever the request carries it.
const CACHE_KEY_HEADERS = ["session-id", "x-session-affinity", "X-Session-Id", "x-opencode-session"]

// OpenAI's limit on prompt_cache_key.
const CACHE_KEY_LENGTH = 64

const RequestBody = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json))

const decodeRequestBody = Schema.decodeUnknownOption(RequestBody)

const encodeRequestBody = Schema.encodeOption(RequestBody)

// The body with its prompt_cache_key replaced, or none when it has none.
export const rewriteCacheKey = (json: string, key: string): Option.Option<string> =>
  decodeRequestBody(json).pipe(
    Option.filter((body) => "prompt_cache_key" in body),
    Option.flatMap((body) => encodeRequestBody({ ...body, prompt_cache_key: key.slice(0, CACHE_KEY_LENGTH) })),
  )

const decompress = (bytes: Uint8Array, encoding: string | null): Uint8Array => {
  switch (encoding ?? "identity") {
    case "zstd":
      return zstdDecompressSync(bytes)
    case "gzip":
      return gunzipSync(bytes)
    default:
      return bytes
  }
}

const compress = (bytes: Uint8Array, encoding: string | null): Uint8Array => {
  switch (encoding ?? "identity") {
    case "zstd":
      return zstdCompressSync(bytes)
    case "gzip":
      return gzipSync(bytes)
    default:
      return bytes
  }
}

// A Finder partition's requests carry the partition's cache group as their
// one OpenAI prompt cache key, in the headers and the body. OpenCode keys
// each session on its own; child sessions would share a key but wake their
// parent when they finish.
export const withCacheKey = (request: Request, key: string) =>
  Effect.tryPromise({ try: () => request.clone().arrayBuffer(), catch: String }).pipe(
    Effect.flatMap((buffer) => {
      const encoding = request.headers.get("content-encoding")

      return Effect.try({
        try: () => new TextDecoder().decode(decompress(new Uint8Array(buffer), encoding)),
        catch: String,
      }).pipe(
        Effect.map((text) =>
          Option.match(rewriteCacheKey(text, key), {
            onNone: () => request,
            onSome: (rewritten) => {
              const headers = new Headers(request.headers)
              headers.delete("content-length")

              // From the request itself, so its signal and redirect policy carry over.
              return new Request(request, {
                method: request.method,
                headers,
                body: compress(new TextEncoder().encode(rewritten), encoding),
              })
            },
          })),
      )
    }),
    // An unreadable body goes out as it was: the key costs cache, not
    // correctness.
    Effect.orElseSucceed(() => request),
  )

const InstructionSource = Schema.Struct({
  key: Schema.String,
  text: Schema.String,
})

const InstructionsMetadata = Schema.Struct({
  experimental: Schema.Struct({
    instructions: Schema.Array(InstructionSource),
  }),
})

const decodeInstructionsMetadata = Schema.decodeUnknownOption(InstructionsMetadata)

const codeModeInstructionText = (parsed: typeof InstructionsMetadata.Type): Option.Option<string> =>
  Array.findFirst(
    parsed.experimental.instructions,
    (entry) => entry.key === CODEMODE_INSTRUCTION_KEY && entry.text.length > 0,
  ).pipe(Option.map((entry) => entry.text))

export const gauntletPlugin = (registry: Registry, services: PluginServices) =>
  Plugin.define({
    id: GAUNTLET_PLUGIN_ID,
    effect: (ctx) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        registry.contexts.set(directory, ctx)
        yield* Effect.addFinalizer(() => Effect.sync(() => registry.contexts.delete(directory)))

        yield* ctx.tool.transform((editor) => {
          for (const [name, emit] of registry.emitTools) {
            editor.add({
              name,
              description: emit.description,
              input: emit.parameters,
              options: { codemode: false },
              execute: emitExecute(registry, name),
            })
          }

          editor.update("read", (tool) => {
            tool.execute = observingPathTool(registry, services.path, requiringInstalled(services, directory, tool.execute))
          })

          editor.update("shell", (tool) => {
            tool.execute = observingShellTool(registry, services.path, requiringInstalledShell(services, directory, tool.execute))
          })

          for (const name of ["grep", "glob"]) {
            editor.update(name, (tool) => {
              tool.execute = observingPathTool(registry, services.path, requiringInstalled(services, directory, tool.execute))
            })
          }

          editor.remove("skill")
        })

        // Scrub repository-selection Git variables before spawning any shell
        // command so model-invoked git commands always inspect the snapshot.
        yield* ctx.shell.hook("create.before", (event) =>
          Effect.sync(() => {
            for (const name of Record.keys(scrubbedGitEnv)) Reflect.deleteProperty(event.env, name)
          }))

        // Track detached Code Mode scripts and record script-level outcomes
        // that never reached an inner wrapped tool (pure JS or syntax error).
        yield* ctx.tool.hook("execute.after", (event) =>
          Effect.sync(() => {
            const route = registry.sessions.get(event.sessionID)

            if (route === undefined || event.tool === route.emit.name) return

            if (event.tool === "execute") {
              if (event.status === "error") {
                route.turnCalls.push({ errored: true })

                return
              }

              const meta = decodeExecuteAfterMetadata(event.result.metadata)

              if (Option.isNone(meta)) {
                route.turnCalls.push({ errored: false })

                return
              }

              if (meta.value.jobID !== undefined) {
                route.lifecycle.trackDetached(meta.value.jobID)

                return
              }

              const inner = meta.value.toolCalls ?? []

              if (inner.length === 0) {
                route.turnCalls.push({ errored: meta.value.error === true })

                return
              }

              if (meta.value.error === true && !Array.some(inner, (call) => call.status === "error")) {
                route.turnCalls.push({ errored: true })
              }

              return
            }

            if (WRAPPED_TOOLS.has(event.tool)) return

            if (event.status === "error") {
              const rawPath = Option.match(decodePathInput(event.input), { onNone: () => undefined, onSome: (fields) => fields.path })
              const normalized = normalizePath(services.path, route.workspace, rawPath)
              route.turnCalls.push(normalized === undefined ? { errored: true } : { errored: true, path: normalized })
            } else {
              route.turnCalls.push({ errored: false })
            }
          }))

        yield* ctx.agent.transform((editor) => {
          for (const [id, definition] of registry.agents.get(directory) ?? []) {
            editor.update(id, (agent) => {
              agent.system = definition.system
              agent.mode = "primary"
              agent.hidden = true
              agent.permissions = permissionsFor(definition)
            })
          }
        })

        // Before every model request: mark delivered detached-job notifications,
        // and once a session's emit has landed stop it here so no request after
        // the emit is built or sent.
        yield* ctx.session.hook("context", (event) => {
          const route = registry.sessions.get(event.sessionID)

          if (route === undefined) return Effect.void

          for (const message of event.messages) {
            const meta = decodeDetachedMetadata(message.metadata)

            if (Option.isSome(meta)) {
              if (meta.value.jobID !== undefined) route.lifecycle.markDelivered(meta.value.jobID)

              if (meta.value.shellID !== undefined) route.lifecycle.markDelivered(meta.value.shellID)
            }
          }

          return route.emitted === undefined
            ? Effect.void
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- OpenCode's plugin API types its failures as unknown; ignored here
            : ctx.session.interrupt({ sessionID: event.sessionID }).pipe(Effect.ignore, Effect.andThen(Effect.never))
        })

        // OpenAI's per-request extras (date, environment, discovered
        // instructions) follow the agent's own system prompt. Keep only the
        // Code Mode catalog when present, so the cached prefix stays stable
        // across days and directories while models still see the catalog.
        yield* ctx.session.hook(
          "context",
          (event) =>
            Effect.sync(() => {
              if (!registry.sessions.has(event.sessionID)) return
              const [role, instructions] = event.system

              if (role === undefined) return

              const codeMode = Option.flatMap(
                Option.fromUndefinedOr(instructions),
                (part) =>
                  decodeInstructionsMetadata(part.metadata).pipe(
                    Option.flatMap(codeModeInstructionText),
                    Option.map((text) => ({ ...part, text })),
                  ),
              )

              event.system = Option.match(codeMode, {
                onNone: () => [role],
                onSome: (part) => [role, part],
              })
            }),
          { providerID: "openai" },
        )

        // Under full_codemode, scripts running past 10s detach into a
        // background job that wakes the session when done. Track that here so
        // `turn()` waits for the wake instead of treating the pause as Stopped.
        yield* ctx.session.hook("experimental.idle", (event) =>
          Effect.sync(() => {
            const route = registry.sessions.get(event.sessionID)

            if (route === undefined || route.emitted !== undefined) return

            const hasRunning = Array.some(
              event.background,
              (work) => work.sessionID === event.sessionID && (work.kind === "codemode" || work.kind === "shell"),
            )

            route.lifecycle.onIdle(hasRunning)
          }))

        yield* ctx.session.hook("model.request", (event) =>
          Effect.sync(() => {
            const key = registry.sessions.get(event.sessionID)?.cacheGroup

            if (key === undefined) return

            for (const name of CACHE_KEY_HEADERS) event.headers[name] = key
          }))
        yield* ctx.session.hook("http.request", (event) => {
          const key = registry.sessions.get(event.sessionID)?.cacheGroup

          if (key === undefined || event.request.body === null) return Effect.void

          return withCacheKey(event.request, key).pipe(
            Effect.map((request) => {
              event.request = request
            }),
          )
        })
        yield* ctx.session.hook("experimental.ws.send", (event) =>
          Effect.sync(() => {
            const key = registry.sessions.get(event.sessionID)?.cacheGroup

            if (key === undefined) return
            event.frame = Option.getOrElse(rewriteCacheKey(event.frame, key), () => event.frame)
          }))

        yield* ctx.event.subscribe({ types: ["session.step.first-token", "session.execution.started"] }).pipe(
          Stream.runForEach((event) =>
            Effect.suspend(() => {
              const route = registry.sessions.get(event.data.sessionID)

              if (route === undefined) return Effect.void

              if (event.type === "session.step.first-token") return Deferred.succeed(route.firstToken, undefined)

              return route.lifecycle.onExecutionStarted
            })),
          Effect.ignore,
          Effect.forkScoped,
        )
      }),
  })

type Client = OpenCode.Interface

const hostError = (operation: string) => (cause: unknown) =>
  HostError.make({ operation, reason: cause instanceof Error ? cause.message : String(cause), cause })

const violation = (reason: string) => (cause: unknown) =>
  AdapterContractViolation.make({ reason: `${reason}: ${cause instanceof Error ? cause.message : String(cause)}` })

const toUsageRow = (tokens: { readonly input: number; readonly output: number; readonly reasoning: number; readonly cache: { readonly read: number; readonly write: number } }): UsageRow => ({
  input: tokens.input,
  output: tokens.output + tokens.reasoning,
  reasoning: tokens.reasoning,
  cacheRead: tokens.cache.read,
  cacheWrite: tokens.cache.write,
})

type Assistant = Extract<Effect.Success<ReturnType<Client["message"]["list"]>>["data"][number], { readonly type: "assistant" }>

const isAssistant = (message: { readonly type: string }): message is Assistant => message.type === "assistant"

const contextLimited = (message: Assistant) =>
  message.finish === "length" ||
  (message.error !== undefined && /context|too long|overflow/i.test(`${message.error.type} ${message.error.message}`))

const endOf = (route: SessionRoute, last: Assistant): TurnEnd => {
  if (route.emitted !== undefined) return TurnEnd.Emitted({ raw: route.emitted })

  if (contextLimited(last)) return TurnEnd.ContextLimit()

  if (last.error !== undefined) {
    return /abort|interrupt/i.test(last.error.type)
      ? TurnEnd.Interrupted({ reason: last.error.message })
      : TurnEnd.ProviderFailed({ reason: `${last.error.type}: ${last.error.message}` })
  }

  return TurnEnd.Stopped()
}

const summarizeToolCalls = (calls: ReadonlyArray<RecordedToolCall>): AgentToolCalls => {
  const errored = Array.filter(calls, (call) => call.errored)
  const erroredPaths = Array.dedupe(Array.flatMap(errored, (call) => (call.path === undefined ? [] : [call.path])))

  return { total: calls.length, errored: errored.length, erroredPaths }
}

export const makeSessions = (client: Client, registry: Registry) => {
  const registering = Semaphore.makeUnsafe(1)

  // Declares the role's agent (and its emit tool) for the Location, reloading
  // an already active plugin, and answers once the agent and the Seat's model
  // are listed there.
  const ensureAgent = Effect.fn("Host.ensureAgent")(function* (spec: AgentSpec) {
    const id = agentID(spec.role)
    const definition: AgentDefinition = { system: spec.systemPrompt, tools: spec.tools, emit: spec.emit.name }
    yield* registering.withPermits(1)(Effect.gen(function* () {
      const newTool = !registry.emitTools.has(spec.emit.name)

      if (newTool) {
        registry.emitTools.set(spec.emit.name, { description: spec.emit.description, parameters: spec.emit.parameters })
      }

      const agents = registry.agents.get(spec.workspace) ?? new Map<string, AgentDefinition>()
      registry.agents.set(spec.workspace, agents)
      const existing = agents.get(id)

      if (existing !== undefined) {
        if (existing.system !== definition.system || existing.emit !== definition.emit ||
          Array.join(existing.tools, ",") !== Array.join(definition.tools, ",")) {
          return yield* HostError.make({ operation: "define agent", reason: `role ${spec.role} was already defined differently in this Run` })
        }

        return
      }

      agents.set(id, definition)
      const ctx = registry.contexts.get(spec.workspace)

      if (ctx === undefined) return
      // An emit tool registered for another Location may be missing here too.
      yield* ctx.tool.reload()
      yield* ctx.agent.reload()
    }))

    const location = { directory: spec.workspace }
    const ref = toModelRef(spec.seat)

    const ready = Effect.zipWith(
      client.agent.list({ location }),
      client.model.list({ location }),
      (agents, models) =>
        Array.some(agents.data, (agent) => agent.id === id) &&
        Array.some(models.data, (model) => model.providerID === ref.providerID && model.id === ref.modelID),
    ).pipe(Effect.mapError(hostError("list agents")))

    // The subscription opens before the first check, so no change between
    // the two goes unseen.
    yield* client.event.subscribe({ types: ["plugin.updated", "agent.updated", "model.updated", "integration.updated"] }).pipe(
      Stream.mapError(hostError("await agent")),
      Stream.filterEffect(() => ready),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: AGENT_READY_TIMEOUT,
        orElse: () =>
          Effect.fail(HostError.make({
            operation: "await agent",
            reason: `model ${ref.providerID}/${ref.modelID} (or agent ${id}) not available after ${Duration.format(AGENT_READY_TIMEOUT)}; ` +
              "for OpenAI run `gauntlet login` or set OPENAI_API_KEY, for Claude sign in to `claude`",
          })),
      }),
    )

    return { id, ref }
  })

  // The newest page, oldest first: a turn's messages are always the newest.
  const assistantMessages = (sessionID: Session.ID) =>
    client.message.list({ sessionID, type: "assistant", order: "desc", limit: MESSAGE_PAGE }).pipe(
      Effect.map((page) => Array.reverse(Array.filter(page.data, isAssistant))),
    )

  const open = Effect.fn("Host.openSession")(function* (spec: AgentSpec) {
    const { id, ref } = yield* ensureAgent(spec)

    const route: SessionRoute = {
      workspace: spec.workspace,
      emit: spec.emit,
      cacheGroup: spec.cacheGroup,
      firstToken: yield* Deferred.make<void>(),
      lifecycle: makeTurnLifecycle(),
      turnCalls: [],
      emitted: undefined,
      rejections: [],
    }

    // Stopping and removing the session is best effort: the Run goes on.
    const session = yield* Effect.acquireRelease(
      client.sessions.create({
        location: { directory: AbsolutePath.make(spec.workspace) },
        agent: Agent.ID.make(id),
        model: Model.Ref.make({ providerID: Provider.ID.make(ref.providerID), id: Model.ID.make(ref.modelID), variant: Model.VariantID.make(ref.variant) }),
        title: spec.invocationId,
      }).pipe(
        Effect.mapError(hostError("create session")),
        Effect.tap((created) => Effect.sync(() => registry.sessions.set(created.id, route))),
      ),
      (created) =>
        client.sessions.interrupt({ sessionID: created.id }).pipe(
          Effect.ignore,
          Effect.andThen(client.sessions.remove({ sessionID: created.id }).pipe(Effect.ignore)),
          Effect.ensuring(Effect.sync(() => registry.sessions.delete(created.id))),
        ),
    )

    const seen = new Set<string>()
    let logged = 0

    // At debug level the Run's log gets the session's transcript: each prompt
    // and each assistant message, tool calls and results included.
    const logTranscript = (entries: ReadonlyArray<object>) =>
      Effect.forEach(entries, (entry) => {
        logged += 1

        return Effect.logDebug("agent transcript", { invocationId: spec.invocationId, entryIndex: logged, entry })
      }, { discard: true }).pipe(Effect.when(LogLevel.isEnabled("Debug")))

    const unseen = (messages: ReadonlyArray<Assistant>) => {
      const fresh = Array.filter(messages, (message) => !seen.has(message.id))

      for (const message of fresh) seen.add(message.id)

      return fresh
    }

    const usageOf = (messages: ReadonlyArray<Assistant>) =>
      Array.flatMap(messages, (message) => (message.tokens === undefined ? [] : [toUsageRow(message.tokens)]))

    const cutShort = Effect.gen(function* () {
      yield* client.sessions.interrupt({ sessionID: session.id }).pipe(Effect.ignore)
      const messages = yield* assistantMessages(session.id).pipe(Effect.orElseSucceed(() => []))
      const fresh = unseen(messages)
      yield* logTranscript(fresh)

      return usageOf(fresh)
    })

    const awaitSettled = Effect.gen(function* () {
      while (true) {
        yield* client.experimental.session.wait({ sessionID: session.id }).pipe(Effect.mapError(violation("wait failed")))

        if (route.emitted !== undefined) return
        const woke = yield* route.lifecycle.awaitNextWake

        if (!woke) return
      }
    })

    const turn = Effect.fn("Host.turn")(function* (text: string) {
      route.lifecycle.resetWaiter()
      route.turnCalls = []
      yield* client.sessions.prompt({ sessionID: session.id, text }).pipe(Effect.mapError(violation("prompt failed")))
      yield* logTranscript([{ role: "user", text }])
      yield* awaitSettled
      const messages = yield* assistantMessages(session.id).pipe(Effect.mapError(violation("reading messages failed")))
      const fresh = unseen(messages)
      yield* logTranscript(fresh)
      const last = Array.last(fresh)

      if (Option.isNone(last)) {
        return yield* AdapterContractViolation.make({ reason: "the turn ended with no assistant message" })
      }

      const diagnostics = route.rejections
      route.rejections = []
      const toolCalls = summarizeToolCalls(route.turnCalls)
      route.turnCalls = []

      return {
        end: endOf(route, last.value),
        usage: usageOf(fresh),
        toolCalls,
        diagnostics,
      } satisfies TurnResult
    })

    return { turn, cutShort, firstToken: Deferred.await(route.firstToken) } satisfies HarnessSession
  })

  return {
    open: (spec: AgentSpec): Effect.Effect<HarnessSession, HostError, Scope.Scope> => open(spec),
  }
}
