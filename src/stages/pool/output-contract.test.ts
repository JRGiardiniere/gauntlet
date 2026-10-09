import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  decodeOutputContract,
  projectOutputContract,
} from "../../harness/output-contract.ts"
import { EmitPool } from "./output-contract.ts"

const strictDecode = decodeOutputContract(EmitPool)

describe("EmitPool contract", () => {
  // Same quiet-degradation tripwire as the harness contracts: projection
  // regressions never fail a real run loudly.
  it.effect("projects self-contained with its description intact", () =>
    Effect.gen(function* () {
      const document = projectOutputContract(EmitPool)
      expect(Object.keys(document.definitions ?? {})).toHaveLength(0)
      const projected = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )({ description: EmitPool.description, parameters: document.schema })
      expect(projected).toContain("must appear in exactly one cluster")
      expect(projected).not.toContain('"additionalProperties":true')
      expect(projected).toContain('"additionalProperties":false')
    }))

  it.effect("canonicalizes summaries and rejects an empty cluster", () =>
    Effect.gen(function* () {
      const pool = yield* strictDecode({
        clusters: [{ indexes: [1], summary: "canonical\nsummary" }],
      })
      expect(pool.clusters[0]?.summary).toBe("canonical summary")

      const failure = yield* Effect.flip(
        strictDecode({ clusters: [{ indexes: [], summary: "empty cluster" }] }),
      )
      expect(failure._tag).toBe("SchemaError")
    }))
})
