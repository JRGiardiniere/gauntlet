import { describe, expect, it } from "vitest"
import rule from "./no-sleep-in-tests.js"
import { runRule } from "./test-utils.ts"

const sleepMember = {
  type: "MemberExpression",
  object: { type: "Identifier", name: "Effect" },
  property: { type: "Identifier", name: "sleep" },
}

describe("no-sleep-in-tests", () => {
  it("reports Effect.sleep in a test file", () => {
    const errors = runRule(rule, "MemberExpression", sleepMember, {
      filename: "/repo/platform/operations/publisher.test.ts",
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("TestClock.adjust")
    expect(errors[0]?.message).toContain("it.live")
    expect(errors[0]?.message).toContain("house-style rule 18")
    expect(errors[0]?.message).toContain("docs/effect-house-style.md")
  })

  it("allows Effect.sleep outside test files", () => {
    expect(
      runRule(rule, "MemberExpression", sleepMember, {
        filename: "/repo/platform/operations/publisher.ts",
      }),
    ).toHaveLength(0)
  })
})
