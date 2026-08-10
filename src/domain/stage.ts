import * as Schema from "effect/Schema"

// The five frozen pipeline phases (docs/spec/pipeline-shape.md). Assembly is
// deterministic code and never holds a model seat.
export const StageName = Schema.Literals([
  "finders",
  "pool",
  "verification",
  "judgment",
  "assembly",
])
export type StageName = typeof StageName.Type

export const SeatedStageName = Schema.Literals([
  "finders",
  "pool",
  "verification",
  "judgment",
])
export type SeatedStageName = typeof SeatedStageName.Type
