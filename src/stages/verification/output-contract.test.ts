import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  decodeOutputContract,
  projectOutputContract,
} from "../../harness/output-contract.ts"
import { EmitVerdicts } from "./output-contract.ts"

const strictDecode = decodeOutputContract(EmitVerdicts)

describe("EmitVerdicts contract", () => {
  // Same quiet-degradation tripwire as the harness contracts: projection
  // regressions never fail a real run loudly.
  it.effect("projects self-contained with the normative descriptions intact", () =>
    Effect.gen(function* () {
      const document = projectOutputContract(EmitVerdicts)
      expect(Object.keys(document.definitions ?? {})).toHaveLength(0)
      const projected = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(document.schema)
      expect(projected).toContain("Slice silence alone never lowers priority")
      expect(projected).toContain("include that reasoning on the same line")
      expect(projected).toContain("Never generated test source or shell commands")
      expect(projected).not.toContain('"additionalProperties":true')
      expect(projected).toContain('"additionalProperties":false')
    }))

  it.effect("fails closed on a missing priority or multi-line evidence, and admits a bare refutation", () =>
    Effect.gen(function* () {
      const unprioritized = yield* Effect.flip(
        strictDecode({
          verdicts: [{ cluster: 1, verdict: "CONFIRMED", evidence: "reproduced" }],
        }),
      )
      expect(unprioritized._tag).toBe("SchemaError")

      for (const evidence of ["first line\nsecond line", "trailing newline\n"]) {
        const multiline = yield* Effect.flip(
          strictDecode({
            verdicts: [
              { cluster: 1, verdict: "CONFIRMED", review_priority: "P2", evidence },
            ],
          }),
        )
        expect(multiline._tag).toBe("SchemaError")
      }

      const refuted = yield* strictDecode({
        verdicts: [
          { cluster: 1, verdict: "REFUTED", evidence: "guard rejects it" },
        ],
      })
      expect(refuted.verdicts).toHaveLength(1)
    }))

  // Missing and empty suggestion contents reach deterministic resolution.
  it.effect("preserves missing and empty test suggestion contents for resolution", () =>
    Effect.gen(function* () {
      const suggested = yield* strictDecode({
        verdicts: [
          {
            cluster: 1,
            verdict: "CONFIRMED",
            review_priority: "P1",
            evidence: "reproduced",
            test_suggestion: {
              tests: ["src/a.test.ts"],
              reason: "covers the boundary",
            },
          },
          {
            cluster: 2,
            verdict: "REFUTED",
            evidence: "guard rejects it",
            test_suggestion: { tests: [], reason: "" },
          },
          {
            cluster: 3,
            verdict: "PLAUSIBLE",
            review_priority: "P3",
            evidence: "needs runtime state",
            test_suggestion: {},
          },
        ],
      })
      expect(suggested.verdicts.map(({ test_suggestion }) => test_suggestion)).toEqual([
        { tests: ["src/a.test.ts"], reason: "covers the boundary" },
        { tests: [], reason: "" },
        {},
      ])
    }))
})
