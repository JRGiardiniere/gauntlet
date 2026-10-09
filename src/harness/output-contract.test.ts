import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { Candidate } from "../domain/candidate.ts"
import {
  decodeOutputContract,
  EmitFindings,
  projectOutputContract,
} from "./output-contract.ts"

describe("output contracts", () => {
  // Projection regressions quietly degrade model guidance (ADR 0008).
  it.effect("projects each contract self-contained with its normative descriptions intact", () =>
    Effect.gen(function* () {
      const sentinels = [
        [EmitFindings, "as it appears in the changed-file list"],
        [EmitFindings, "Do not copy source or invent references"],
      ] as const
      for (const [contract, sentinel] of sentinels) {
        const document = projectOutputContract(contract)
        expect(Object.keys(document.definitions ?? {})).toHaveLength(0)
        const projected = yield* Schema.encodeEffect(
          Schema.fromJsonString(Schema.Unknown),
        )({
          toolName: contract.toolName,
          description: contract.description,
          parameters: document.schema,
        })
        expect(projected).toContain(sentinel)
        expect(projected).not.toContain('"additionalProperties":true')
        expect(projected).toContain('"additionalProperties":false')
      }
    }))

  it.effect("rejects blank model-authored text in the projected tool schema", () =>
    Effect.gen(function* () {
      const projected = yield* Schema.encodeEffect(
        Schema.fromJsonString(Schema.Unknown),
      )(projectOutputContract(EmitFindings).schema)
      expect(projected).toContain(String.raw`"pattern":"\\S"`)
    }))

  it.effect("accepts empty finder output and an arbitrary candidate path", () =>
    Effect.gen(function* () {
      expect(yield* decodeOutputContract(EmitFindings)({ findings: [] })).toEqual({
        findings: [],
      })
      const output = yield* decodeOutputContract(EmitFindings)({
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
      const findings = yield* decodeOutputContract(EmitFindings)({
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
    }))

  it.effect("preserves source references through the output and Candidate codecs", () =>
    Effect.gen(function* () {
      const references = ["src/helper.ts"]
      const output = yield* decodeOutputContract(EmitFindings)({ findings: [{
        file: "src/a.ts", summary: "claim", source_references: references,
      }] })
      expect(output.findings[0]?.source_references).toEqual(references)
      const candidate: Candidate = { _tag: "Observation", id: "a", lens: "test", file: "a.ts",
        summary: "claim", sourceReferences: references }
      const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Candidate))(candidate)
      expect(yield* Schema.decodeEffect(Schema.fromJsonString(Candidate))(encoded)).toEqual(candidate)
    }))

  it.effect("requires JSON-safe 1-indexed integer locations", () =>
    Effect.gen(function* () {
      const decode = decodeOutputContract(EmitFindings)
      for (const line of [0, 1.5, Number.NaN]) {
        const failure = yield* Effect.flip(
          decode({
            findings: [{ file: "src/a.ts", line, summary: "bad line" }],
          }),
        )
        expect(failure._tag).toBe("SchemaError")
      }
    }))

  it.effect("fails closed on excess fields", () =>
    Effect.gen(function* () {
      const findingsFailure = yield* Effect.flip(
        decodeOutputContract(EmitFindings)({
          findings: [
            { file: "src/a.ts", summary: "extra", review_priority: "P1" },
          ],
        }),
      )
      expect(findingsFailure._tag).toBe("SchemaError")
    }))
})
