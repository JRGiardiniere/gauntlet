import { describe, expect, it } from "vitest"
import rule from "./no-manual-tag-check.js"
import { runRule } from "./test-utils.ts"

const tagAccess = (name: string, property: unknown = { type: "Identifier", name: "_tag" }) => ({
  type: "MemberExpression",
  object: { type: "Identifier", name },
  property,
  computed: property !== null && typeof property === "object" && "value" in property,
})

describe("no-manual-tag-check", () => {
  it("reports equality checks against an error tag", () => {
    const access = tagAccess("error")
    const node = {
      type: "BinaryExpression",
      operator: "===",
      left: access,
      right: { type: "StringLiteral", value: "DomainError" },
    }

    expect(
      runRule(rule, "BinaryExpression", node),
    ).toHaveLength(1)
  })

  it("reports computed _tag comparisons on a cause", () => {
    const access = tagAccess("cause", { type: "StringLiteral", value: "_tag" })
    const node = {
      type: "BinaryExpression",
      operator: "!==",
      left: access,
      right: { type: "StringLiteral", value: "DomainError" },
    }

    expect(
      runRule(rule, "BinaryExpression", node),
    ).toHaveLength(1)
  })

  it("allows narrowing an unknown with an _tag membership check", () => {
    const node = {
      type: "BinaryExpression",
      operator: "in",
      left: { type: "StringLiteral", value: "_tag" },
      right: { type: "Identifier", name: "failure" },
    }

    expect(runRule(rule, "BinaryExpression", node)).toHaveLength(0)
  })

  it("allows tagged state unions", () => {
    const access = tagAccess("prepared")
    const node = {
      type: "BinaryExpression",
      operator: "===",
      left: access,
      right: { type: "StringLiteral", value: "Prepared" },
    }

    expect(
      runRule(rule, "BinaryExpression", node),
    ).toHaveLength(0)
  })

  it("allows reading an error tag for serialization", () => {
    expect(
      runRule(rule, "MemberExpression", tagAccess("error")),
    ).toHaveLength(0)
  })
})
