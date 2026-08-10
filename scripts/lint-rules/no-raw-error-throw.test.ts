import { describe, expect, it } from "vitest"
import rule from "./no-raw-error-throw.js"
import { runRule } from "./test-utils.ts"

const thrownConstruction = (name: string) => ({
  type: "ThrowStatement",
  argument: {
    type: "NewExpression",
    callee: { type: "Identifier", name },
    arguments: [],
  },
})

describe("no-raw-error-throw", () => {
  it("reports throwing a raw Error", () => {
    expect(
      runRule(rule, "ThrowStatement", thrownConstruction("Error")),
    ).toHaveLength(1)
  })

  it("allows throwing a tagged error construction", () => {
    expect(
      runRule(rule, "ThrowStatement", thrownConstruction("DomainError")),
    ).toHaveLength(0)
  })
})
