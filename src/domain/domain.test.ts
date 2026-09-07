import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Candidate } from "./candidate.ts"
import { Seat } from "./recipe.ts"

describe("domain model", () => {
  it.effect("requires 1-indexed Candidate lines", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Candidate)
      const candidate = {
        _tag: "Observation",
        id: "fixture-lens/1",
        lens: "fixture-lens",
        file: "src/alpha.ts",
        summary: "off-by-one in the pager",
      }
      expect(yield* decode({ ...candidate, line: 1 })).toEqual({
        ...candidate,
        line: 1,
      })
      const rejected = yield* Effect.flip(decode({ ...candidate, line: 0 }))
      expect(rejected._tag).toBe("SchemaError")
    }))

  it.effect("a seat follows the provider/model:effort grammar", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Seat)
      // Model ids may contain colons; only the trailing segment is effort.
      expect(yield* decode("acme/luna-4:high")).toBe("acme/luna-4:high")
      expect(yield* decode("acme/luna:4-6:high")).toBe("acme/luna:4-6:high")
      const rejected = yield* Effect.flip(decode("just-a-model"))
      expect(rejected._tag).toBe("SchemaError")
    }))
})
