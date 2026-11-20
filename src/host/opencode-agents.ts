// oxlint-disable-next-line effecttsgo/node-builtin-import -- Effect's Path has no glob matcher, and this is the OpenCode tool adapter boundary
import { matchesGlob } from "node:path"
import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { FileAccess } from "@opencode/core/file-access"
import { GlobTool } from "@opencode/core/tool/plugin/glob"
import { GrepTool } from "@opencode/core/tool/plugin/grep"
import { Plugin } from "@opencode/plugin/effect"
import { AbsolutePath, Agent, Model, type OpenCode, Provider, type Session, Tool } from "@opencode/sdk/effect"
import * as Array from "effect/Array"
import * as LogLevel from "effect/LogLevel"
import * as Option from "effect/Option"
import * as Deferred from "effect/Deferred"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Stream from "effect/Stream"
import type { AgentToolCalls } from "../domain/agent-outcome.ts"
import { DEPENDENCIES } from "../run/installed-dependencies.ts"
import { isProtectedPath, PROTECTED_RESOURCES } from "../workspace/protected-paths.ts"
import {
  AdapterContractViolation,
  type AgentSpec,
  type HarnessSession,
  INSPECTION_TOOLS,
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

// The spike's grep default: enough matches to locate code, small enough that
// a broad pattern does not flood the context.
const GREP_DEFAULT_LIMIT = 30

// OpenCode's own glob default.
const GLOB_DEFAULT_LIMIT = 100

// A search of exposed dependencies with its own include or pattern collects
// this many results before filtering them.
const DEPENDENCY_SEARCH_LIMIT = 2000

const EVERYTHING = "*"

// Bounds paging through a session's assistant messages.
const MESSAGE_PAGE = 200

const READ_DESCRIPTION = Array.join([
  "Read lines of a file, or a directory's entries. Each text line is prefixed by its 1-based line number as <line>: <content>; the prefix is not part of the file.",
  "Read only the region you need: find it with grep first, then pass offset and limit (usually 40-150 lines). The change's diff and touched files are already in your context, so do not re-read them.",
  "Output is capped at 2000 lines or 50 KB.",
], " ")

const GREP_DESCRIPTION = Array.join([
  `Search file contents with ripgrep regular expressions (or literal text). Returns matching lines without context, grouped by file, at most \`limit\` lines (default ${String(GREP_DEFAULT_LIMIT)}).`,
  "Combine related searches into one call with alternation (a|b|c) instead of several calls, and narrow with path and include. Then read only the lines around a match with offset and limit.",
], " ")

interface AgentDefinition {
  readonly system: string
  readonly tools: ReadonlyArray<InspectionTool>
  readonly emit: string
}

interface EmitDefinition {
  readonly description: string
  readonly parameters: AgentSpec["emit"]["parameters"]
}

// What the plugin knows about one open session.
interface SessionRoute {
  readonly emit: AgentSpec["emit"]
  readonly cacheGroup: string | undefined
  readonly firstToken: Deferred.Deferred<void>
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
  // Each Location's exposed dependency directories, as real paths.
  readonly dependencies: Map<string, ReadonlyArray<string>>
}

export const makeRegistry = (): Registry => ({
  agents: new Map(),
  emitTools: new Map(),
  contexts: new Map(),
  sessions: new Map(),
  dependencies: new Map(),
})

// Last match wins: everything denied, so nothing falls through to asking;
// then the read tools the Stage uses and its own emit tool; then secrets, the
// snapshot's `.git` file and anything outside the snapshot, denied again over
// those allows. A tool reaches the model only when its last rule is not a
// whole-tool deny, so the read denies come only with `read` itself: Pool, with
// no read tools, sees its emit tool only.
export const permissionsFor = (definition: Pick<AgentDefinition, "tools" | "emit">) => [
  { action: "*", resource: "*", effect: "deny" as const },
  ...Array.map(definition.tools, (tool) => ({ action: tool, resource: "*", effect: "allow" as const })),
  { action: definition.emit, resource: "*", effect: "allow" as const },
  ...(Array.contains(definition.tools, "read")
    ? Array.map(PROTECTED_RESOURCES, (resource) => ({ action: "read", resource, effect: "deny" as const }))
    : []),
  { action: "external_directory", resource: "*", effect: "deny" as const },
]

// What the fence checks paths with; the plugin runs inside OpenCode, so
// Gauntlet hands these over when it boots the Host.
export interface FenceServices {
  readonly fs: FileSystem.FileSystem
  readonly path: Path.Path
}

// The real path of the deepest part of `target` that exists, with the rest
// appended: a missing file inside the snapshot is the tool's own not-found.
const realPathOf = ({ fs, path }: FenceServices, target: string): Effect.Effect<string> =>
  fs.realPath(target).pipe(
    Effect.catch(() => {
      const parent = path.dirname(target)

      return parent === target
        ? Effect.succeed(target)
        : Effect.map(realPathOf({ fs, path }, parent), (real) => path.join(real, path.basename(target)))
    }),
  )

const escapes = (path: Path.Path, relative: string) =>
  relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)

const within = (path: Path.Path, directory: string, target: string) => !escapes(path, path.relative(directory, target))

// The tool error for a `path` the snapshot at `root` (real path `realRoot`)
// does not serve, resolved exactly as the tool resolves it (`~`, `..`,
// absolute), or undefined when it serves it. OpenCode decides "inside"
// lexically and reads follow symlinks, so the real path is checked as well:
// an outbound symlink is refused here, unless its real path lies in one of
// the Caller's installed `node_modules` the snapshot exposes
// (`dependencies`). grep and glob check their pattern, not their path,
// against the rules, so the protected paths are refused here for them too.
const fenceRefusal = Effect.fn("Fence.refusal")(function* (
  services: FenceServices,
  root: string,
  realRoot: string,
  dependencies: ReadonlyArray<string>,
  input: string,
) {
  const { fs, path } = services
  const outside = `Refused: ${input} is outside the review snapshot.`
  const unreadable = `Refused: ${input} is not readable in the review snapshot.`
  const resolved = FileAccess.resolvePath(root, input)
  const lexical = path.relative(root, resolved)

  if (escapes(path, lexical)) return outside

  if (isProtectedPath(lexical)) return unreadable

  // A `node_modules` missing from the snapshot was not installed there.
  const segments = lexical.split(path.sep)
  const dependencyIndex = segments.indexOf(DEPENDENCIES)

  if (dependencyIndex >= 0) {
    const installed = yield* fs.exists(path.join(root, ...segments.slice(0, dependencyIndex + 1))).pipe(
      Effect.orElseSucceed(() => false),
    )

    if (!installed) {
      return `Unavailable: dependencies were not installed in the caller's checkout, so ${input} is not available to this review.`
    }
  }

  const realResolved = yield* realPathOf(services, resolved)
  const real = path.relative(realRoot, realResolved)

  if (!escapes(path, real)) return isProtectedPath(real) ? unreadable : undefined

  return Option.match(Array.findFirst(dependencies, (directory) => within(path, directory, realResolved)), {
    onNone: () => outside,
    onSome: (directory) => (isProtectedPath(path.relative(directory, realResolved)) ? unreadable : undefined),
  })
})

// The directory a grep or glob call searches, when it lies in exposed
// dependencies.
const dependencySearchDirectory = (
  services: FenceServices,
  root: string,
  dependencies: ReadonlyArray<string>,
  input: string | undefined,
): Effect.Effect<Option.Option<string>> =>
  Effect.gen(function* () {
    if (dependencies.length === 0) return Option.none()
    const resolved = FileAccess.resolvePath(root, input ?? ".")
    const real = yield* realPathOf(services, resolved)

    if (!Array.some(dependencies, (directory) => within(services.path, directory, real))) return Option.none()

    const directory = yield* services.fs.stat(resolved).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    )

    return Option.some(directory ? resolved : services.path.dirname(resolved))
  })

// How ripgrep reads an include or glob pattern: without a slash it matches a
// file's name at any depth, with one the path below the searched directory.
const matchesSearchGlob = (path: Path.Path, glob: string, relative: string) =>
  glob.includes("/") ? matchesGlob(relative, glob.replace(/^\//, "")) : matchesGlob(path.basename(relative), glob)

const PathInput = Schema.Struct({ path: Schema.optionalKey(Schema.String) })

const decodePathInput = Schema.decodeUnknownOption(PathInput)

const decodeGrepMatches = Schema.decodeUnknownOption(GrepTool.Output)

const decodeGlobEntries = Schema.decodeUnknownOption(GlobTool.Output)

type ToolResult = Effect.Success<ReturnType<Tool.Info["execute"]>>

const truncatedResult = (result: ToolResult) => result.metadata?.["truncated"] === true

// A grep result cut to the matches whose snapshot-relative path is kept, and
// to `limit` of them.
const keepMatches = (
  path: Path.Path,
  root: string,
  result: ToolResult,
  keep: (relative: string) => boolean,
  limit = Number.POSITIVE_INFINITY,
): ToolResult =>
  Option.match(decodeGrepMatches(result.output), {
    onNone: () => result,
    onSome: (matches) => {
      const matching = Array.filter(matches, (match) => keep(match.entry.path))

      if (matching.length === matches.length && matching.length <= limit) return result
      const kept = matching.slice(0, limit)
      const truncated = truncatedResult(result) || matching.length > limit
      const shown = Array.map(kept, (match) => ({ ...match, entry: { ...match.entry, path: path.resolve(root, match.entry.path) } }))

      return {
        ...result,
        output: kept,
        content: GrepTool.toModelContent(shown, truncated),
        metadata: { ...result.metadata, matches: kept.length, truncated },
      }
    },
  })

// The same for a glob result's entries; a protected path is never listed.
const keepEntries = (
  path: Path.Path,
  root: string,
  result: ToolResult,
  keep: (relative: string) => boolean,
  limit: number,
): ToolResult =>
  Option.match(decodeGlobEntries(result.output), {
    onNone: () => result,
    onSome: (entries) => {
      const matching = Array.filter(entries, (entry) => !isProtectedPath(entry.path) && keep(entry.path))
      const kept = matching.slice(0, limit)
      const truncated = truncatedResult(result) || matching.length > limit
      const shown = Array.map(kept, (entry) => ({ ...entry, path: path.resolve(root, entry.path) }))

      return {
        ...result,
        output: kept,
        content: GlobTool.toModelContent(shown, truncated),
        metadata: { ...result.metadata, count: kept.length, truncated },
      }
    },
  })

// grep searches hidden files, so a directory search would quote a tracked
// `.env` and the snapshot's `.git` file; their matches are dropped.
const withoutSensitiveMatches = (path: Path.Path, root: string, result: ToolResult): ToolResult =>
  keepMatches(path, root, result, (relative) => !isProtectedPath(relative))

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

const decodeToolInput = Schema.decodeUnknownOption(Schema.Record(Schema.String, Schema.Unknown))

// The grep and glob fields the wrappers read; the rest pass through as given.
const SearchInput = Schema.Struct({
  path: Schema.optionalKey(Schema.String),
  pattern: Schema.optionalKey(Schema.String),
  include: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Finite),
})

const decodeSearchFields = Schema.decodeUnknownOption(SearchInput)

export const gauntletPlugin = (registry: Registry, services: FenceServices) =>
  Plugin.define({
    id: GAUNTLET_PLUGIN_ID,
    effect: (ctx) =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const realRoot = yield* realPathOf(services, directory)
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
            tool.description = READ_DESCRIPTION
          })
          const dependencies = () => registry.dependencies.get(directory) ?? []

          // ripgrep runs in a search's real directory, which for exposed
          // dependencies is inside the Caller's checkout, so that checkout's
          // ignore rules (`dist/`, `*.log`) would prune it. A glob matching
          // everything overrides them; the call's own include or pattern
          // then filters what came back.
          const searchingDependencies = (searchPath: string | undefined) =>
            dependencySearchDirectory(services, directory, dependencies(), searchPath)

          const belowSearched = (searched: string, glob: string) => (relative: string) =>
            matchesSearchGlob(services.path, glob, services.path.relative(searched, services.path.resolve(directory, relative)))

          editor.update("grep", (tool) => {
            tool.description = GREP_DESCRIPTION
            const execute = tool.execute
            tool.execute = (input, context) =>
              Option.match(Option.all({ raw: decodeToolInput(input), fields: decodeSearchFields(input) }), {
                onNone: () => execute(input, context),
                onSome: ({ fields, raw }) =>
                  searchingDependencies(fields.path).pipe(Effect.flatMap((searched) => {
                    const limit = fields.limit ?? GREP_DEFAULT_LIMIT
                    const include = fields.include

                    if (Option.isNone(searched)) return execute({ ...raw, limit }, context)

                    if (include === undefined) return execute({ ...raw, limit, include: EVERYTHING }, context)

                    return execute({ ...raw, include: EVERYTHING, limit: DEPENDENCY_SEARCH_LIMIT }, context).pipe(
                      Effect.map((result) => keepMatches(services.path, directory, result, belowSearched(searched.value, include), limit)),
                    )
                  })),
              }).pipe(Effect.map((result) => withoutSensitiveMatches(services.path, directory, result)))
          })

          editor.update("glob", (tool) => {
            const execute = tool.execute
            tool.execute = (input, context) =>
              Option.match(Option.all({ raw: decodeToolInput(input), fields: decodeSearchFields(input) }), {
                onNone: () => execute(input, context),
                onSome: ({ fields, raw }) =>
                  searchingDependencies(fields.path).pipe(Effect.flatMap((searched) => {
                    const pattern = fields.pattern

                    if (Option.isNone(searched) || pattern === undefined) return execute(input, context)

                    return execute({ ...raw, pattern: EVERYTHING, limit: DEPENDENCY_SEARCH_LIMIT }, context).pipe(
                      Effect.map((result) =>
                        keepEntries(services.path, directory, result, belowSearched(searched.value, pattern), fields.limit ?? GLOB_DEFAULT_LIMIT)),
                    )
                  })),
              })
          })

          // The fence check wraps the tool itself rather than an
          // `execute.before` hook: it sees the decoded input after every hook,
          // so a later hook (input repair, a renamed call) cannot change the
          // path once it has been checked.
          for (const name of INSPECTION_TOOLS) {
            editor.update(name, (tool) => {
              const execute = tool.execute
              tool.execute = (input, context) =>
                fenceRefusal(services, directory, realRoot, dependencies(), Option.match(decodePathInput(input), {
                  onNone: () => ".",
                  onSome: (fields) => fields.path ?? ".",
                })).pipe(
                  Effect.flatMap((refusal) =>
                    refusal === undefined ? execute(input, context) : Effect.fail(Tool.Error.make({ message: refusal }))),
                )
            })
          }

          editor.remove("skill")
        })

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

        // Before every model request: once a session's emit has landed, stop
        // it here, so the request after the emit is never built or sent.
        yield* ctx.session.hook("context", (event) =>
          registry.sessions.get(event.sessionID)?.emitted === undefined
            ? Effect.void
            // @effect-diagnostics-next-line anyUnknownInErrorContext:off -- OpenCode's plugin API types its failures as unknown; ignored here
            : ctx.session.interrupt({ sessionID: event.sessionID }).pipe(Effect.ignore, Effect.andThen(Effect.never)))

        // OpenAI's per-request extras (date, environment, discovered
        // instructions) follow the agent's own system prompt; Gauntlet's
        // prompts carry everything a Stage needs, so only that stays.
        yield* ctx.session.hook(
          "context",
          (event) =>
            Effect.sync(() => {
              if (registry.sessions.has(event.sessionID)) event.system = event.system.slice(0, 1)
            }),
          { providerID: "openai" },
        )

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

        yield* ctx.event.subscribe({ types: ["session.step.first-token"] }).pipe(
          Stream.runForEach((event) =>
            Effect.suspend(() => {
              const route = registry.sessions.get(event.data.sessionID)

              return route === undefined ? Effect.void : Deferred.succeed(route.firstToken, undefined)
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

const toolCallsOf = (path: Path.Path, workspace: string, messages: ReadonlyArray<Assistant>, emit: string): AgentToolCalls => {
  const calls = Array.flatMap(messages, (message) =>
    Array.filter(message.content, (part) => part.type === "tool" && part.name !== emit))

  const errored = Array.filter(calls, (part) => part.type === "tool" && part.state.status === "error")

  const erroredPaths = Array.flatMap(errored, (part) =>
    Option.match(part.type === "tool" ? decodePathInput(part.state.input) : Option.none(), {
      onNone: () => [],
      onSome: ({ path: input }) => {
        if (input === undefined) return []
        const relative = path.relative(workspace, FileAccess.resolvePath(workspace, input))

        return [escapes(path, relative) ? input : relative === "" ? "." : relative]
      },
    }))

  return { total: calls.length, errored: errored.length, erroredPaths: Array.dedupe(erroredPaths) }
}

export const makeSessions = (client: Client, registry: Registry, path: Path.Path) => {
  const registering = Semaphore.makeUnsafe(1)

  // Declares the role's agent (and its emit tool) for the Location, reloading
  // an already active plugin, and answers once the agent and the Seat's model
  // are listed there.
  const ensureAgent = Effect.fn("Host.ensureAgent")(function* (spec: AgentSpec) {
    const id = agentID(spec.role)
    const definition: AgentDefinition = { system: spec.systemPrompt, tools: spec.tools, emit: spec.emit.name }
    registry.dependencies.set(spec.workspace, spec.dependencies ?? [])
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
      emit: spec.emit,
      cacheGroup: spec.cacheGroup,
      firstToken: yield* Deferred.make<void>(),
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

    const turn = Effect.fn("Host.turn")(function* (text: string) {
        yield* client.sessions.prompt({ sessionID: session.id, text }).pipe(Effect.mapError(violation("prompt failed")))
        yield* logTranscript([{ role: "user", text }])
        yield* client.experimental.session.wait({ sessionID: session.id }).pipe(Effect.mapError(violation("wait failed")))
        const messages = yield* assistantMessages(session.id).pipe(Effect.mapError(violation("reading messages failed")))
        const fresh = unseen(messages)
        yield* logTranscript(fresh)
        const last = Array.last(fresh)

        if (Option.isNone(last)) {
          return yield* AdapterContractViolation.make({ reason: "the turn ended with no assistant message" })
        }

        const diagnostics = route.rejections
        route.rejections = []

        return {
          end: endOf(route, last.value),
          usage: usageOf(fresh),
          toolCalls: toolCallsOf(path, spec.workspace, fresh, spec.emit.name),
          diagnostics,
        } satisfies TurnResult
      })

    return { turn, cutShort, firstToken: Deferred.await(route.firstToken) } satisfies HarnessSession
  })

  return {
    open: (spec: AgentSpec): Effect.Effect<HarnessSession, HostError, Scope.Scope> => open(spec),
  }
}
