import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import type * as Scope from "effect/Scope"
import { gauntletHome } from "../config/settings.ts"
import type { AgentSpec, HarnessSession } from "../harness/harness-session.ts"

// The embedded OpenCode Host (#197): Gauntlet's own OpenCode, isolated from
// the person's, booted only by the commands that need it. This module is the
// cheap half; the OpenCode packages load from opencode-host.ts on first use.

export class HostError extends Schema.TaggedError<
  HostError,
  { readonly brand: unique symbol }
>()("HostError", {
  operation: Schema.String,
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface HostModel {
  readonly providerID: string
  readonly id: string
  readonly variants: ReadonlyArray<string>
}

export type ConnectionState = Data.TaggedEnum<{
  Connected: {}
  NeedsAuth: { readonly message: string }
  NotConnected: {}
}>

export const ConnectionState = Data.taggedEnum<ConnectionState>()

export interface SignInAttempt {
  readonly attemptID: string
  readonly url: string
  readonly instructions: string
  // Whether the redirect URL can be pasted in place of the browser callback.
  readonly paste: boolean
}

export type SignInStatus = Data.TaggedEnum<{
  Pending: {}
  Complete: {}
  Failed: { readonly message: string }
  Expired: {}
}>

export const SignInStatus = Data.taggedEnum<SignInStatus>()

export type PasteResult = Data.TaggedEnum<{
  Accepted: {}
  Rejected: { readonly reason: string }
}>

export const PasteResult = Data.taggedEnum<PasteResult>()

export interface HostContract {
  // One AgentInvocation's session, stopped and removed when the scope closes.
  readonly openSession: (spec: AgentSpec) => Effect.Effect<HarnessSession, HostError, Scope.Scope>
  readonly listModels: Effect.Effect<ReadonlyArray<HostModel>, HostError>
  readonly connection: (
    integration: "openai" | "claude-agent",
  ) => Effect.Effect<ConnectionState, HostError>
  readonly chatGptSignIn: {
    readonly start: Effect.Effect<SignInAttempt, HostError>
    readonly status: (attemptID: string) => Effect.Effect<SignInStatus, HostError>
    // Hands over the pasted redirect URL; the outcome still arrives through
    // status. Rejected means the URL was refused and another paste can help.
    readonly paste: (attemptID: string, redirectUrl: string) => Effect.Effect<PasteResult, HostError>
    readonly cancel: (attemptID: string) => Effect.Effect<void>
  }
}

export class Host extends Context.Service<Host, HostContract>()("gauntlet/Host") {}

// Where the Host keeps everything: its store, and every OpenCode global path.
export interface HostPaths {
  readonly home: string
  readonly root: string
  readonly database: string
  // An empty directory standing in for a project when no Run supplies one.
  readonly location: string
}

export const hostPaths = Effect.fn("Host.paths")(function* () {
  const path = yield* Path.Path
  const gauntlet = yield* gauntletHome()
  const root = path.join(gauntlet, "opencode")

  return {
    home: path.dirname(gauntlet),
    root,
    database: path.join(root, "gauntlet.db"),
    location: path.join(root, "location"),
  } satisfies HostPaths
})

// OpenCode's own models.dev fetch, cached in the store, unless a test hands
// the Host a fixture catalog file so it stays offline.
export type ModelCatalog = Data.TaggedEnum<{
  Fetch: {}
  File: { readonly path: string }
}>

export const ModelCatalog = Data.taggedEnum<ModelCatalog>()

export const hostLayer = (impl: HostContract) => Layer.succeed(Host, Host.of(impl))

// For commands that must never boot the Host: any use is a defect.
const untouched = Effect.die("the Host was used by a command that must not boot it")

export const untouchedHostLayer = hostLayer({
  openSession: () => untouched,
  listModels: untouched,
  connection: () => untouched,
  chatGptSignIn: {
    start: untouched,
    status: () => untouched,
    paste: () => untouched,
    cancel: () => untouched,
  },
})
