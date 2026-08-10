import { describe, expect, it } from "vitest"
import rule from "./no-instanceof-tagged-error.js"
import { runRule } from "./test-utils.ts"

const instanceofExpression = (name: string, operator = "instanceof") => ({
  type: "BinaryExpression",
  operator,
  left: { type: "Identifier", name: "error" },
  right: { type: "Identifier", name },
})

describe("no-instanceof-tagged-error", () => {
  it("reports instanceof checks against a tagged error name", () => {
    expect(
      runRule(rule, "BinaryExpression", instanceofExpression("DomainError")),
    ).toHaveLength(1)
  })

  it("allows instanceof checks against the built-in Error", () => {
    expect(
      runRule(rule, "BinaryExpression", instanceofExpression("Error")),
    ).toHaveLength(0)
  })

  it("ignores other binary operators", () => {
    expect(
      runRule(
        rule,
        "BinaryExpression",
        instanceofExpression("DomainError", "==="),
      ),
    ).toHaveLength(0)
  })
})
