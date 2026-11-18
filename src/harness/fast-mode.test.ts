import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { withFastTier } from "./fast-mode.ts"

class FastTierError extends Schema.TaggedError<
  FastTierError,
  { readonly brand: unique symbol }
>()("FastTierError", {
  reason: Schema.String,
}) {}

interface Request {
  readonly model: string
  readonly store?: boolean
}
const request: Request = { model: "gpt-6.1-terra" }
const send = <B>(onPayload: (payload: Request, model: string) => Promise<B>) =>
  Effect.tryPromise({
    try: () => onPayload(request, "openai/gpt-6.1-terra"),
    catch: (cause) => FastTierError.make({ reason: String(cause) }),
  })

describe("withFastTier", () => {
  it.effect("adds the priority tier after Pi's own payload transform", () =>
    Effect.gen(function* () {
      const body = yield* send(withFastTier((payload: Request) => ({ ...payload, store: false })))
      expect(body).toEqual({ ...request, store: false, service_tier: "priority" })
    }))

  it.effect("keeps the original body when Pi's transform leaves it unchanged", () =>
    Effect.gen(function* () {
      const unchanged = yield* send(withFastTier<Request, string>(() => undefined))
      expect(unchanged).toEqual({ ...request, service_tier: "priority" })
      const untransformed = yield* send(withFastTier<Request, string>(undefined))
      expect(untransformed).toEqual({ ...request, service_tier: "priority" })
    }))
})
