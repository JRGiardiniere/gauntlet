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
  // A projection regression degrades agent output quietly — no real run fails
  // loudly — so this tripwire survives the instantly-loud cull. It only fires
  // on a deliberate Effect bump (the pin is exact) or a contract edit.
  it.effect("projects each contract self-contained with its normative descriptions intact", () =>
    Effect.gen(function* () {
      const sentinels = [
        [EmitFindings, "as it appears in the changed-file list"],
        [EmitPool, "must appear in exactly one cluster"],
        [EmitVerdicts, "reachability × consequence"],
        [EmitVerdicts, "Never generated test source or shell commands"],
      ] as const
      for (const [contract, sentinel] of sentinels) {
        const document = Schema.toJsonSchemaDocument(contract.schema)
        expect(Object.keys(document.definitions ?? {})).toHaveLength(0)
        const projected = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )({
          toolName: contract.toolName,
          description: contract.description,
          parameters: document.schema,
        })
        expect(projected).toContain(sentinel)
      }
    }))

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

  // Content-loose by design: a malformed suggestion must reach deterministic
  // resolution (which drops it with a diagnostic) instead of the decoder
  // fail-closing the bundle's verdicts.
  it.effect("decodes any shaped test suggestion, even semantically invalid ones", () =>
    Effect.gen(function* () {
      const decode = strictDecode(EmitVerdicts.schema)
      const suggested = yield* decode({
        verdicts: [
          {
            cluster: 1,
            verdict: "CONFIRMED",
            severity: "P1",
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
            verdict: "UNVERIFIED",
            severity: "P3",
            evidence: "needs runtime state",
            test_suggestion: {},
          },
        ],
      })
      expect(suggested.verdicts).toHaveLength(3)
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
