import { describe, expect, it } from "vitest"
import rule from "./effect-fn-gauntlet-prefix.js"
import { effectFnCall, runRule } from "./test-utils.ts"

describe("effect-fn-gauntlet-prefix", () => {
  it("reports a production span without the gauntlet prefix", () => {
    const errors = runRule(
      rule,
      "CallExpression",
      effectFnCall("Publisher.publish"),
      { filename: "/repo/platform/operations/publisher.ts" },
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain(
      "gauntlet.<snake_case_module>.<snake_case_method>",
    )
    expect(errors[0]?.message).toContain("house-style rule 17")
    expect(errors[0]?.message).toContain("docs/effect-house-style.md")
  })

  it("allows a production span with the gauntlet prefix", () => {
    expect(
      runRule(
        rule,
        "CallExpression",
        effectFnCall("gauntlet.publisher.publish"),
        { filename: "/repo/platform/operations/publisher.ts" },
      ),
    ).toHaveLength(0)
  })

  it("leaves a non-dotted span to effect-fn-span-shape instead of double-reporting", () => {
    expect(
      runRule(
        rule,
        "CallExpression",
        effectFnCall("publish"),
        { filename: "/repo/platform/operations/publisher.ts" },
      ),
    ).toHaveLength(0)
  })

  it("leaves a non-literal span name to effect-fn-span-shape", () => {
    expect(
      runRule(
        rule,
        "CallExpression",
        effectFnCall({ type: "TemplateLiteral" }),
        { filename: "/repo/platform/operations/publisher.ts" },
      ),
    ).toHaveLength(0)
  })

  it.each([
    "/repo/publisher.test.ts",
    "/repo/publisher.fake.ts",
    "/repo/publisher.integration.ts",
  ])("exempts %s", (filename) => {
    expect(
      runRule(
        rule,
        "CallExpression",
        effectFnCall("Publisher.publish"),
        { filename },
      ),
    ).toHaveLength(0)
  })

  it.each(["Publisher.Fake.build", "Publisher.Test.build"])(
    "allows the sanctioned static test surface %s",
    (spanName) => {
      expect(
        runRule(
          rule,
          "CallExpression",
          effectFnCall(spanName),
          { filename: "/repo/platform/operations/publisher.ts" },
        ),
      ).toHaveLength(0)
    },
  )
})
