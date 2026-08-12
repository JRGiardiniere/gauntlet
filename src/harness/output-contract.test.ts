import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import {
  EmitFindings,
  EmitPool,
  EmitVerdicts,
} from "./output-contract.ts"

const strictDecode = <O>(schema: Schema.Codec<O, O, never, never>) =>
  Schema.decodeUnknownEffect(schema, { onExcessProperty: "error" })

describe("output contracts", () => {
  it.effect("accepts empty finder output and an arbitrary candidate path", () =>
    Effect.gen(function* () {
      expect(yield* strictDecode(EmitFindings.schema)({ findings: [] })).toEqual({
        findings: [],
      })
      const output = yield* strictDecode(EmitFindings.schema)({
        findings: [
          {
            file: "not-in-the-changed-file-list.ts",
            summary: "kept for downstream warning",
          },
        ],
      })
      expect(output.findings[0]?.file).toBe("not-in-the-changed-file-list.ts")
    }))

  it.effect("canonicalizes model-authored text used by line-oriented prompts", () =>
    Effect.gen(function* () {
      const findings = yield* strictDecode(EmitFindings.schema)({
        findings: [
          {
            file: " src/a.ts\n",
            summary: "first line\r\nsecond line",
            failure_scenario: "empty input\nthrows",
          },
        ],
      })
      expect(findings.findings).toEqual([
        {
          file: "src/a.ts",
          summary: "first line second line",
          failure_scenario: "empty input throws",
        },
      ])

      const pool = yield* strictDecode(EmitPool.schema)({
        clusters: [{ indexes: [1], summary: "canonical\nsummary" }],
      })
      expect(pool.clusters[0]?.summary).toBe("canonical summary")
    }))

  it.effect("requires JSON-safe 1-indexed integer locations", () =>
    Effect.gen(function* () {
      const decode = strictDecode(EmitFindings.schema)
      for (const line of [0, 1.5, Number.NaN]) {
        const failure = yield* Effect.flip(
          decode({
            findings: [{ file: "src/a.ts", line, summary: "bad line" }],
          }),
        )
        expect(failure._tag).toBe("SchemaError")
      }
    }))

  it.effect("fails closed on excess fields and conditional verdict fields", () =>
    Effect.gen(function* () {
      const findingsFailure = yield* Effect.flip(
        strictDecode(EmitFindings.schema)({
          findings: [
            { file: "src/a.ts", summary: "extra", severity: "P1" },
          ],
        }),
      )
      expect(findingsFailure._tag).toBe("SchemaError")

      const verdictFailure = yield* Effect.flip(
        strictDecode(EmitVerdicts.schema)({
          verdicts: [
            {
              cluster: 1,
              verdict: "CONFIRMED",
              evidence: "reproduced",
            },
          ],
        }),
      )
      expect(verdictFailure._tag).toBe("SchemaError")

      for (const evidence of ["first line\nsecond line", "trailing newline\n"]) {
        const multilineEvidenceFailure = yield* Effect.flip(
          strictDecode(EmitVerdicts.schema)({
            verdicts: [
              {
                cluster: 1,
                verdict: "CONFIRMED",
                severity: "P2",
                evidence,
              },
            ],
          }),
        )
        expect(multilineEvidenceFailure._tag).toBe("SchemaError")
      }

      const refuted = yield* strictDecode(EmitVerdicts.schema)({
        verdicts: [
          { cluster: 1, verdict: "REFUTED", evidence: "guard rejects it" },
        ],
      })
      expect(refuted.verdicts).toHaveLength(1)
    }))

  it.effect("requires non-empty pool clusters", () =>
    Effect.gen(function* () {
      const poolFailure = yield* Effect.flip(
        strictDecode(EmitPool.schema)({
          clusters: [{ indexes: [], summary: "empty cluster" }],
        }),
      )
      expect(poolFailure._tag).toBe("SchemaError")
    }))
})
