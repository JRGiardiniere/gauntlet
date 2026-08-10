import { describe, expect, it } from "vitest"
import rule from "./no-schema-class.js"
import { runRule } from "./test-utils.ts"

const memberExpression = (namespace: string, property: string) => ({
  type: "MemberExpression",
  object: { type: "Identifier", name: namespace },
  property: { type: "Identifier", name: property },
})

describe("no-schema-class", () => {
  it.each(["Class", "TaggedClass"])("reports Schema.%s", (property) => {
    const errors = runRule(
      rule,
      "MemberExpression",
      memberExpression("Schema", property),
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("plain Schema.Struct models")
    expect(errors[0]?.message).toContain("Data.TaggedError")
    expect(errors[0]?.message).toContain(
      "banned by the Effect skill's SCHEMA.md",
    )
    expect(errors[0]?.message).toContain("no numbered house-style rule covers this")
    expect(errors[0]?.message).toContain("docs/effect-house-style.md")
  })

  it("allows Data.TaggedError", () => {
    expect(
      runRule(
        rule,
        "MemberExpression",
        memberExpression("Data", "TaggedError"),
      ),
    ).toHaveLength(0)
  })
})
