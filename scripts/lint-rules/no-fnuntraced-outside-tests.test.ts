import { describe, expect, it } from "vitest"
import rule from "./no-fnuntraced-outside-tests.js"
import { runRule } from "./test-utils.ts"

const fnUntracedMember = {
  type: "MemberExpression",
  object: { type: "Identifier", name: "Effect" },
  property: { type: "Identifier", name: "fnUntraced" },
}

describe("no-fnuntraced-outside-tests", () => {
  it("reports Effect.fnUntraced in a production TypeScript file", () => {
    const errors = runRule(rule, "MemberExpression", fnUntracedMember, {
      filename: "/repo/platform/operations/publisher.ts",
    })

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain('Effect.fn("gauntlet....")')
    expect(errors[0]?.message).toContain("house-style rule 25")
    expect(errors[0]?.message).toContain("docs/effect-house-style.md")
  })

  it("allows Effect.fnUntraced in a test file", () => {
    expect(
      runRule(rule, "MemberExpression", fnUntracedMember, {
        filename: "/repo/platform/operations/publisher.test.ts",
      }),
    ).toHaveLength(0)
  })
})
