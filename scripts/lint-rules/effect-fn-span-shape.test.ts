import { describe, expect, it } from "vitest"
import rule from "./effect-fn-span-shape.js"
import { effectFnCall, runRule } from "./test-utils.ts"

describe("effect-fn-span-shape", () => {
  it.each(["publish", ".publish", "Publisher.", "Publisher..publish"])(
    "reports the invalid span name %s",
    (spanName) => {
      const errors = runRule(rule, "CallExpression", effectFnCall(spanName))

      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toContain("gauntlet.<snake_case_module>.<snake_case_method>")
      expect(errors[0]?.message).toContain("house-style rules 17/25")
      expect(errors[0]?.message).toContain("docs/effect-house-style.md")
    },
  )

  it.each([
    ["a template-literal span name", { type: "TemplateLiteral" }],
    ["a constant reference span name", { type: "Identifier", name: "SPAN_NAME" }],
  ])("reports %s as non-checkable", (_label, argument) => {
    const errors = runRule(rule, "CallExpression", effectFnCall(argument))

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("static string literals")
    expect(errors[0]?.message).toContain("house-style rules 17/25")
  })

  it("reports a name-less Effect.fn call as non-checkable", () => {
    const errors = runRule(rule, "CallExpression", effectFnCall())

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("static string literals")
  })

  it.each(["Publisher.publish", "gauntlet.publisher.publish"])(
    "allows the dotted span name %s",
    (spanName) => {
      expect(
        runRule(rule, "CallExpression", effectFnCall(spanName)),
      ).toHaveLength(0)
    },
  )
})
