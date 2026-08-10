import { describe, expect, it } from "vitest"
import rule from "./no-record-string-unknown.js"
import { runRule } from "./test-utils.ts"

const node = { type: "TSTypeReference", range: [0, 23] }

describe("no-record-string-unknown", () => {
  it("reports an unknown-valued string record", () => {
    const errors = runRule(rule, "TSTypeReference", node, {
      sourceCode: "Record<string, unknown>",
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("authoritative domain type or schema")
    expect(errors[0]?.message).toContain("surface the missing model to the user")
  })

  it("reports an any-valued string record more strongly", () => {
    const errors = runRule(rule, "TSTypeReference", node, {
      sourceCode: "Record<string, any>",
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("disables type checking")
  })

  it("reports the equivalent string index signature", () => {
    expect(
      runRule(rule, "TSIndexSignature", { type: "TSIndexSignature" }, {
        sourceCode: "readonly [key: string]: unknown",
      }),
    ).toHaveLength(1)
  })

  it("allows records whose value type is modeled", () => {
    expect(
      runRule(rule, "TSTypeReference", node, {
        sourceCode: "Record<string, AppRecord>",
      }),
    ).toHaveLength(0)
  })
})
