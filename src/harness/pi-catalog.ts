import { ModelRuntime } from "@earendil-works/pi-coding-agent"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

export class ModelCatalogRefreshError extends Schema.TaggedError<
  ModelCatalogRefreshError,
  { readonly brand: unique symbol }
>()("ModelCatalogRefreshError", {
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

// Pi's network catalog refresh — the call `pi update --models` makes — which
// persists to ~/.pi/agent/models-store.json, so later review runs resolve the
// same catalog. Per-provider refresh errors are not fatal: a stale provider
// catalog can only miss an upgrade, never offer a wrong one.
export const refreshedModelCatalog = Effect.fn("gauntlet.pi.refresh_catalog")(
  function* () {
    const refreshError = (cause: unknown) =>
      ModelCatalogRefreshError.make({ reason: String(cause), cause })
    const runtime = yield* Effect.tryPromise({
      try: (signal) => ModelRuntime.create({ signal }),
      catch: refreshError,
    })
    const result = yield* Effect.tryPromise({
      try: (signal) => runtime.refresh({ allowNetwork: true, force: true, signal }),
      catch: refreshError,
    })
    if (result.aborted) {
      return yield* ModelCatalogRefreshError.make({ reason: "refresh aborted" })
    }
    return (provider: string): ReadonlyArray<string> =>
      Array.map(runtime.getModels(provider), (model) => model.id)
  },
  Effect.timeoutOrElse({
    duration: "15 seconds",
    orElse: () =>
      Effect.fail(ModelCatalogRefreshError.make({ reason: "timed out" })),
  }),
)
