import * as Schema from "effect/Schema"

// The Pi APIs whose requests take OpenAI's `service_tier`.
export const FAST_MODE_APIS: ReadonlySet<string> = new Set([
  "openai-responses",
  "openai-codex-responses",
])

const isRequestBody = Schema.is(Schema.Record(Schema.String, Schema.Unknown))

// Fast mode for a `+fast` Seat, as Pi's `onPayload` hook. Pi's simple stream
// drops a serviceTier option, so the tier goes on the request body after Pi's
// own payload transform; the response's tier then prices the usage.
export const withFastTier = <P, M>(
  transform: ((payload: P, model: M) => P | undefined | Promise<P | undefined>) | undefined,
) =>
(payload: P, model: M) =>
  Promise.resolve(transform?.(payload, model)).then((transformed) => {
    const body = transformed ?? payload
    return isRequestBody(body) ? { ...body, service_tier: "priority" } : body
  })
