import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { EmitJudgments } from "./output-contract.ts"

const strictDecode = Schema.decodeUnknownEffect(EmitJudgments.schema, {
  onExcessProperty: "error",
})

describe("EmitJudgments contract", () => {
  it.effect("projects a self-contained JSON Schema with the rating descriptions", () =>
    Effect.gen(function* () {
      const document = Schema.toJsonSchemaDocument(EmitJudgments.schema)
      expect(Object.keys(document.definitions ?? {})).toHaveLength(0)
      const projected = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )({
        toolName: EmitJudgments.toolName,
        description: EmitJudgments.description,
        parameters: document.schema,
      })
      expect(projected).toContain(
        "Reading ONLY the finder's own summary",
      )
    }))

  it.effect("admits keep-only fields on keeps and rejects them on drops", () =>
    Effect.gen(function* () {
      const dropFailure = yield* Effect.flip(
        strictDecode({
          decisions: [
            {
              index: 1,
              decision: "drop",
              tier: "P3",
              reason: "false premise",
            },
          ],
        }),
      )
      expect(dropFailure._tag).toBe("SchemaError")

      const kept = yield* strictDecode({
        decisions: [
          {
            index: 1,
            decision: "keep",
            tier: "P2",
            reason: "warranted and checked",
            goodFind: true,
            cleanlyExplained: true,
          },
        ],
      })
      expect(kept.decisions).toHaveLength(1)
    }))
})
