import * as Schema from "effect/Schema"

// The durable record of what one external delivery attempt actually did,
// independent of whether the review itself completed (CONTEXT.md). v1
// delivery is a single PR comment; oversize output truncates evidence
// before identity, recorded here.
export const DeliveryReceipt = Schema.TaggedUnion({
  Posted: {
    runId: Schema.NonEmptyString,
    url: Schema.NonEmptyString,
    truncated: Schema.Boolean,
  },
  NotPosted: {
    runId: Schema.NonEmptyString,
    reason: Schema.NonEmptyString,
  },
})
export type DeliveryReceipt = typeof DeliveryReceipt.Type
