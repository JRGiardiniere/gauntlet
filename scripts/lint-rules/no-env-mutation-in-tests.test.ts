import { describe, expect, it } from "vitest"
import rule from "./no-env-mutation-in-tests.js"
import { runRule } from "./test-utils.ts"

const processEnvVariable = (property: unknown) => ({
  type: "MemberExpression",
  object: {
    type: "MemberExpression",
    object: { type: "Identifier", name: "process" },
    property: { type: "Identifier", name: "env" },
  },
  property,
})

describe("no-env-mutation-in-tests", () => {
  it.each([
    { type: "Identifier", name: "HUB_TOKEN" },
    { type: "Literal", value: "HUB_TOKEN" },
  ])("reports assignment to process.env", (property) => {
    const errors = runRule(
      rule,
      "AssignmentExpression",
      {
        type: "AssignmentExpression",
        operator: "=",
        left: processEnvVariable(property),
        right: { type: "Literal", value: "test" },
      },
      { filename: "/repo/platform/operations/publisher.test.ts" },
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("test layers or ConfigProvider")
    expect(errors[0]?.message).toContain("house-style rule 20")
    expect(errors[0]?.message).toContain("docs/effect-house-style.md")
  })

  it("reports deletion from process.env", () => {
    expect(
      runRule(
        rule,
        "UnaryExpression",
        {
          type: "UnaryExpression",
          operator: "delete",
          argument: processEnvVariable({
            type: "Identifier",
            name: "HUB_TOKEN",
          }),
        },
        { filename: "/repo/platform/operations/publisher.test.ts" },
      ),
    ).toHaveLength(1)
  })

  it("reports wholesale reassignment of process.env", () => {
    expect(
      runRule(
        rule,
        "AssignmentExpression",
        {
          type: "AssignmentExpression",
          operator: "=",
          left: {
            type: "MemberExpression",
            object: { type: "Identifier", name: "process" },
            property: { type: "Identifier", name: "env" },
          },
          right: { type: "ObjectExpression", properties: [] },
        },
        { filename: "/repo/platform/operations/publisher.test.ts" },
      ),
    ).toHaveLength(1)
  })

  it("reports Object.assign onto process.env", () => {
    expect(
      runRule(
        rule,
        "CallExpression",
        {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            object: { type: "Identifier", name: "Object" },
            property: { type: "Identifier", name: "assign" },
          },
          arguments: [
            {
              type: "MemberExpression",
              object: { type: "Identifier", name: "process" },
              property: { type: "Identifier", name: "env" },
            },
            { type: "ObjectExpression", properties: [] },
          ],
        },
        { filename: "/repo/platform/operations/publisher.test.ts" },
      ),
    ).toHaveLength(1)
  })

  it("allows Object.assign onto an ordinary object", () => {
    expect(
      runRule(
        rule,
        "CallExpression",
        {
          type: "CallExpression",
          callee: {
            type: "MemberExpression",
            object: { type: "Identifier", name: "Object" },
            property: { type: "Identifier", name: "assign" },
          },
          arguments: [
            { type: "Identifier", name: "config" },
            { type: "ObjectExpression", properties: [] },
          ],
        },
        { filename: "/repo/platform/operations/publisher.test.ts" },
      ),
    ).toHaveLength(0)
  })

  it("allows assignment to an ordinary object", () => {
    expect(
      runRule(
        rule,
        "AssignmentExpression",
        {
          type: "AssignmentExpression",
          operator: "=",
          left: {
            type: "MemberExpression",
            object: { type: "Identifier", name: "config" },
            property: { type: "Identifier", name: "HUB_TOKEN" },
          },
          right: { type: "Literal", value: "test" },
        },
        { filename: "/repo/platform/operations/publisher.test.ts" },
      ),
    ).toHaveLength(0)
  })
})
