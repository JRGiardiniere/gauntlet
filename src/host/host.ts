import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { gauntletHome } from "../config/settings.ts"

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

export type ConnectionState =
  | { readonly _tag: "Connected" }
  | { readonly _tag: "NeedsAuth"; readonly message: string }
  | { readonly _tag: "NotConnected" }

export interface SignInAttempt {
  readonly attemptID: string
  readonly url: string
  readonly instructions: string
  // Whether the redirect URL can be pasted in place of the browser callback.
  readonly paste: boolean
}

export type SignInStatus =
  | { readonly _tag: "Pending" }
  | { readonly _tag: "Complete" }
  | { readonly _tag: "Failed"; readonly message: string }
  | { readonly _tag: "Expired" }

export type PasteResult = { readonly _tag: "Accepted" } | { readonly _tag: "Rejected"; readonly reason: string }

export interface HostContract {
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
export type ModelCatalog =
  | { readonly _tag: "Fetch" }
  | { readonly _tag: "File"; readonly path: string }

export const hostLayer = (impl: HostContract) => Layer.succeed(Host, Host.of(impl))

// For commands that must never boot the Host: any use is a defect.
const untouched = Effect.die("the Host was used by a command that must not boot it")
export const untouchedHostLayer = hostLayer({
  listModels: untouched,
  connection: () => untouched,
  chatGptSignIn: {
    start: untouched,
    status: () => untouched,
    paste: () => untouched,
    cancel: () => untouched,
  },
})
