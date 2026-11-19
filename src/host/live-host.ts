import * as Effect from "effect/Effect"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import type * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Scope from "effect/Scope"
import { Host, HostError, hostPaths, type ModelCatalog } from "./host.ts"
import { scrubHostEnvironment } from "./host-environment.ts"

const failure = (operation: string) => (cause: unknown) =>
  HostError.make({
    operation,
    reason: cause instanceof Error ? cause.message : String(cause),
    cause,
  })

// The Host boots on first use and stays up for the rest of the layer's
// lifetime, so commands that never touch it never load OpenCode.
export const liveHostLayer = (catalog: ModelCatalog = { _tag: "Fetch" }) =>
  Layer.effect(
    Host,
    Effect.gen(function* () {
      const scope = yield* Effect.scope
      const context = yield* Effect.context<Path.Path | FileSystem.FileSystem>()
      const booted = yield* Effect.cached(
        Effect.gen(function* () {
          const paths = yield* hostPaths()
          yield* scrubHostEnvironment(process.env)
          const module = yield* Effect.tryPromise({
            try: () => import("./opencode-host.ts"),
            catch: failure("load"),
          })
          return yield* module.bootHost(paths, catalog)
        }).pipe(
          Effect.mapError((cause) =>
            Schema.is(HostError)(cause) ? cause : failure("boot")(cause)),
          Effect.provideContext(context),
          Effect.provideService(Scope.Scope, scope),
        ),
      )
      return Host.of({
        listModels: Effect.flatMap(booted, (host) => host.listModels),
        connection: (integration) => Effect.flatMap(booted, (host) => host.connection(integration)),
        chatGptSignIn: {
          start: Effect.flatMap(booted, (host) => host.chatGptSignIn.start),
          status: (attemptID) => Effect.flatMap(booted, (host) => host.chatGptSignIn.status(attemptID)),
          paste: (attemptID, url) => Effect.flatMap(booted, (host) => host.chatGptSignIn.paste(attemptID, url)),
          cancel: (attemptID) =>
            Effect.flatMap(booted, (host) => host.chatGptSignIn.cancel(attemptID)).pipe(Effect.ignore),
        },
      })
    }),
  )

