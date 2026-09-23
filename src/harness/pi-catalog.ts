import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"

export class ModelCatalogRefreshError extends Data.TaggedError(
  "ModelCatalogRefreshError",
)<{
  readonly reason: string
  readonly cause?: unknown
}> {}

// Pi's network catalog refresh — the call `pi update --models` makes — which
// persists to ~/.pi/agent/models-store.json, so later review runs resolve the
// same catalog. Per-provider refresh errors are not fatal: a stale provider
// catalog can only miss an upgrade, never offer a wrong one.
export const refreshedModelCatalog = Effect.fn("gauntlet.pi.refresh_catalog")(
  function* () {
    const refreshError = (cause: unknown) =>
      new ModelCatalogRefreshError({ reason: String(cause), cause })
    const runtime = yield* Effect.tryPromise({
      try: (signal) => ModelRuntime.create({ signal }),
      catch: refreshError,
    })
    const result = yield* Effect.tryPromise({
      try: (signal) => runtime.refresh({ allowNetwork: true, force: true, signal }),
      catch: refreshError,
    })
    if (result.aborted) {
      return yield* new ModelCatalogRefreshError({ reason: "refresh aborted" })
    }
    return (provider: string): ReadonlyArray<string> =>
      runtime.getModels(provider).map((model) => model.id)
  },
  Effect.timeoutOrElse({
    duration: "15 seconds",
    orElse: () =>
      Effect.fail(new ModelCatalogRefreshError({ reason: "timed out" })),
  }),
)
