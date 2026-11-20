import { Config } from "@opencode/core/config"
import { Integration } from "@opencode/core/integration"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionRestart } from "@opencode/core/session/execution/restart"
import { SessionInstructions } from "@opencode/core/session/instructions"
import { OpenCode } from "@opencode/sdk/effect"
import { Global } from "@opencode/util/global"
import * as Duration from "effect/Duration"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { type FenceServices, GAUNTLET_PLUGIN_ID, gauntletPlugin, makeRegistry, makeSessions } from "./opencode-agents.ts"
import {
  type ConnectionState,
  type HostContract,
  HostError,
  type HostModel,
  type HostPaths,
  type ModelCatalog,
  type PasteResult,
  type SignInAttempt,
  type SignInStatus,
} from "./host.ts"

// What a Run needs from OpenCode: an agent, the two providers, three read
// tools and the prompt and config plugins they lean on. `-*` also drops SDK
// plugins, so Gauntlet's own plugin is listed too.
export const KEPT_PLUGINS = [
  GAUNTLET_PLUGIN_ID,
  "opencode.agent",
  "opencode.config.agent",
  "opencode.config.provider",
  "opencode.models.dev",
  "opencode.provider.claude-agent",
  "opencode.provider.chatgpt",
  "opencode.provider.openai",
  "opencode.provider.openai-context-caps",
  "opencode.provider.prompt-cache-key",
  "opencode.prompt.anthropic",
  "opencode.prompt.openai",
  "opencode.tool.input.repair",
  "opencode.tool.read",
  "opencode.tool.grep",
  "opencode.tool.glob",
] as const

const OPENAI = Integration.ID.make("openai")

const CLAUDE = Integration.ID.make("claude-agent")

const CHATGPT_METHOD = Integration.MethodID.make("chatgpt-token-sharing")

const CLAUDE_METHOD = Integration.MethodID.make("claude-login")

// Bounds each wait on the Host getting ready, so a stuck plugin or `claude`
// probe fails the command instead of hanging it.
const READY_TIMEOUT = Duration.seconds(30)

// Past OpenCode's own 30-second start timeout for `claude`.
const CLAUDE_PROBE_TIMEOUT = Duration.seconds(45)

const attempt = (attemptID: string) => Integration.AttemptID.make(attemptID)

const hostError = (operation: string) => (cause: unknown) =>
  HostError.make({
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

// Every OpenCode global path under Gauntlet's directory: the person's own
// OpenCode config, sessions and legacy auth.json are never read or imported.
const globalPaths = (paths: HostPaths, path: Path.Path) => ({
  home: paths.home,
  data: path.join(paths.root, "data"),
  state: path.join(paths.root, "state"),
  cache: path.join(paths.root, "cache"),
  config: path.join(paths.root, "config"),
  log: path.join(paths.root, "log"),
  bin: path.join(paths.root, "bin"),
  repos: path.join(paths.root, "repos"),
  tmp: path.join(paths.root, "tmp"),
})

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

// Gauntlet's whole OpenCode config; no config file is read.
const HOST_CONFIG = {
  plugins: ["-*", ...KEPT_PLUGINS],
  snapshots: false,
  share: "disabled",
  compaction: { auto: false },
}

const catalogOptions = (catalog: ModelCatalog) =>
  catalog._tag === "File"
    ? { file: catalog.path, fetch: false, snapshot: false }
    : { snapshot: false }

const hostOptions = (
  paths: HostPaths,
  catalog: ModelCatalog,
  services: FenceServices,
  content: string,
  registry: ReturnType<typeof makeRegistry>,
) => ({
  plugins: [gauntletPlugin(registry, services)],
  app: { name: "gauntlet", channel: "gauntlet" },
  database: { path: paths.database },
  config: {
    directory: globalPaths(paths, services.path).config,
    project: false,
    claude: false,
    content,
  },
  instructions: { claude: false },
  fs: { filewatcher: false, fff: false },
  events: { persist: false },
  models: catalogOptions(catalog),
})

// Discovery the server options cannot reach: global and system config roots,
// ~/.agents, and global instructions. The read tool loads every AGENTS.md
// between a file it reads and the snapshot root as session instructions,
// whatever the discovery options say, so that loader is replaced with one that
// loads nothing: a reviewed repo's nested AGENTS.md never reaches an agent.
// Session resume is replaced because a claim has no owner: on a shared store,
// resuming at start would re-run another Gauntlet process's live turns.
const hostOverrides = (paths: HostPaths, path: Path.Path, content: string) => [
  Global.node.replace(Global.layerWith(globalPaths(paths, path))),
  Config.node.replace(
    Config.configured({
      project: false,
      global: false,
      system: false,
      claude: false,
      content,
    }),
  ),
  InstructionDiscovery.node.replace(
    InstructionDiscovery.configured({ project: false, global: false, claude: false }),
  ),
  SessionInstructions.node.replace(
    Layer.succeed(SessionInstructions.Service, SessionInstructions.Service.of({ load: () => Effect.void })),
  ),
  SessionRestart.node.replace(
    Layer.succeed(SessionRestart.Service, SessionRestart.Service.of({ resumeSuspendedSessions: Effect.void })),
  ),
]

const toSignInStatus = (
  status: { readonly status: "pending" | "complete" | "expired" } | {
    readonly status: "failed"
    readonly message: string
  },
): SignInStatus => {
  switch (status.status) {
    case "pending":
      return { _tag: "Pending" }
    case "complete":
      return { _tag: "Complete" }
    case "expired":
      return { _tag: "Expired" }
    case "failed":
      return { _tag: "Failed", message: status.message }
  }
}

// Tests replace OpenCode services, such as its language model client.
export type HostOverrides = ReturnType<typeof hostOverrides>

export const bootHost = Effect.fn("Host.boot")(function* (
  paths: HostPaths,
  catalog: ModelCatalog,
  testOverrides: HostOverrides = [],
) {
  const path = yield* Path.Path
  const fs = yield* FileSystem.FileSystem
  yield* fs.makeDirectory(paths.location, { recursive: true }).pipe(Effect.mapError(hostError("boot")))
  const content = yield* encodeJson(HOST_CONFIG).pipe(Effect.mapError(hostError("boot")))
  const registry = makeRegistry()

  const client = yield* OpenCode.create(hostOptions(paths, catalog, { fs, path }, content, registry), {
    overrides: [...hostOverrides(paths, path, content), ...testOverrides],
  }).pipe(Effect.mapError(hostError("boot")))

  const location = { directory: AbsolutePath.make(paths.location) }

  const integration = (integrationID: typeof OPENAI) =>
    client.integration.get({ location, integrationID }).pipe(
      Effect.mapBoth({
        onSuccess: (response) => response.data,
        onFailure: hostError(`integration ${integrationID}`),
      }),
    )

  const models = client.model.list({ location }).pipe(
    Effect.mapBoth({
      onSuccess: (response) =>
        Array.map(response.data, (model): HostModel => ({
          providerID: model.providerID,
          id: model.id,
          variants: Array.map(model.variants, (variant) => variant.id),
        })),
      onFailure: hostError("list models"),
    }),
  )

  // Checks `ready` when the event subscription opens and again on each event
  // of the given types, until it holds. The subscription opens before the
  // first check, so no change between the two goes unseen.
  const awaitReady = (
    operation: string,
    types: ReadonlyArray<string>,
    ready: Effect.Effect<boolean, HostError>,
    timeout: Duration.Duration = READY_TIMEOUT,
  ) =>
    client.event.subscribe().pipe(
      Stream.filter((event) => event.type === "server.connected" || types.includes(event.type)),
      Stream.mapError(hostError(operation)),
      Stream.filterEffect(() => ready),
      Stream.runHead,
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => Effect.fail(HostError.make({ operation, reason: `not ready after ${Duration.format(timeout)}` })),
      }),
      Effect.asVoid,
    )

  // A Location activates its plugins on its first request, asynchronously.
  yield* awaitReady(
    "activate plugins",
    ["plugin.updated", "integration.updated"],
    client.integration.list({ location }).pipe(
      Effect.mapBoth({
        onSuccess: (response) => {
          const ids = new Set<string>(Array.map(response.data, (info) => info.id))

          return ids.has(OPENAI) && ids.has(CLAUDE)
        },
        onFailure: hostError("activate plugins"),
      }),
    ),
  )

  // Claude needs no sign-in: recording the external connection lets the
  // claude-agent provider use the installed `claude` login.
  const claudeConnected = yield* integration(CLAUDE).pipe(Effect.map((info) => info.connections.length > 0))

  if (!claudeConnected) {
    yield* client.integration.connect
      .external({ location, integrationID: CLAUDE, methodID: CLAUDE_METHOD })
      .pipe(Effect.mapError(hostError("connect claude")))
  }

  // The provider then probes `claude` in the background: seconds the first
  // time, after which the store keeps its model list; a logged-out `claude`
  // takes OpenCode's own 30-second start timeout to report. Only the Claude
  // connection report waits for it.
  const claudeProbed = yield* Effect.cached(awaitReady(
    "probe claude",
    ["model.updated", "integration.updated"],
    Effect.zipWith(
      models,
      integration(CLAUDE),
      (listed, info) =>
        Array.some(listed, (model) => model.providerID === CLAUDE) ||
        Array.some(info.connections, (connection) => connection.status !== undefined),
    ),
    CLAUDE_PROBE_TIMEOUT,
  ))

  const connection = Effect.fn("Host.connection")(function* (integrationID: "openai" | "claude-agent") {
    if (integrationID === "claude-agent") yield* claudeProbed
    const info = yield* integration(integrationID === "openai" ? OPENAI : CLAUDE)
    const first = info.connections[0]

    if (first === undefined) return { _tag: "NotConnected" } satisfies ConnectionState

    if (first.status !== undefined) {
      return { _tag: "NeedsAuth", message: first.status.message } satisfies ConnectionState
    }

    return { _tag: "Connected" } satisfies ConnectionState
  })

  const sessions = makeSessions(client, registry)

  const contract: HostContract = {
    openSession: sessions.open,
    listModels: models,
    connection,
    chatGptSignIn: {
      start: client.integration.oauth
        .connect({ location, integrationID: OPENAI, methodID: CHATGPT_METHOD })
        .pipe(
          Effect.mapBoth({
            onSuccess: (response): SignInAttempt => ({
              attemptID: response.data.attemptID,
              url: response.data.url,
              instructions: response.data.instructions,
              paste: response.data.paste === true || response.data.mode === "code",
            }),
            onFailure: hostError("start sign-in"),
          }),
        ),
      status: (attemptID) =>
        client.integration.oauth.status({ location, integrationID: OPENAI, attemptID: attempt(attemptID) }).pipe(
          Effect.mapBoth({
            onSuccess: (response) => toSignInStatus(response.data),
            onFailure: hostError("sign-in status"),
          }),
        ),
      paste: (attemptID, code) =>
        client.integration.oauth.complete({ location, integrationID: OPENAI, attemptID: attempt(attemptID), code }).pipe(
          Effect.as<PasteResult>({ _tag: "Accepted" }),
          Effect.catchTag("InvalidRequestError", (refused) =>
            Effect.succeed<PasteResult>({ _tag: "Rejected", reason: refused.message })),
          Effect.mapError(hostError("complete sign-in")),
        ),
      cancel: (attemptID) =>
        client.integration.oauth.cancel({ location, integrationID: OPENAI, attemptID: attempt(attemptID) }).pipe(Effect.ignore),
    },
  }

  // The raw client serves the Host's own tests.
  return { ...contract, client, location }
})
