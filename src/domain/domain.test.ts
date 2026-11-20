import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Candidate } from "./candidate.ts"
import { Recipe, Seat, seatSpeed } from "./recipe.ts"

describe("domain model", () => {
  it.effect("requires 1-indexed Candidate lines", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Candidate)

      const candidate = Candidate.cases.Observation.make({
        id: "fixture-lens/1",
        lens: "fixture-lens",
        file: "src/alpha.ts",
        summary: "off-by-one in the pager",
      })

      const decodedCandidate = yield* decode({ ...candidate, line: 1 })
      expect(decodedCandidate).toEqual({
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
      const colonlessSeat = yield* decode("acme/luna-4:high")
      expect(colonlessSeat).toBe("acme/luna-4:high")
      const colonSeat = yield* decode("acme/luna:4-6:high")
      expect(colonSeat).toBe("acme/luna:4-6:high")
      const rejected = yield* Effect.flip(decode("just-a-model"))
      expect(rejected._tag).toBe("SchemaError")
    }))

  it.effect("a seat's effort may end in +fast", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Seat)
      const fastSeat = yield* decode("acme/terra:4:high+fast")
      expect(seatSpeed(fastSeat)).toEqual({ seat: "acme/terra:4:high", fast: true })
      const plainSeat = yield* decode("acme/terra:high")
      expect(seatSpeed(plainSeat)).toEqual({ seat: "acme/terra:high", fast: false })
    }))

  it.effect("one Recipe seats any provider in any Stage", () =>
    Effect.gen(function* () {
      const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Recipe), { onExcessProperty: "error" })
      const mixed = yield* decode(`{"default":"acme/luna:high","verification":"claude-code/sonnet:low"}`)
      expect(mixed).toEqual({ default: "acme/luna:high", verification: "claude-code/sonnet:low" })
    }))
})
