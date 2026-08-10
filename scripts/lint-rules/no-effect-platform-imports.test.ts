import { describe, expect, it } from "vitest"
import rule from "./no-effect-platform-imports.js"
import { runRule } from "./test-utils.ts"

const importDeclaration = (source: string) => ({
  type: "ImportDeclaration",
  source: { value: source },
})

describe("no-effect-platform-imports", () => {
  it.each([
    "@effect/platform",
    "@effect/platform/HttpClient",
    "@effect/platform-bun",
    "@effect/platform-bun/BunRuntime",
    "@effect/platform-browser",
    "@effect/platform-browser/BrowserHttpClient",
    "@effect/platform-node-shared",
  ])("reports an import from %s", (source) => {
    const errors = runRule(
      rule,
      "ImportDeclaration",
      importDeclaration(source),
    )

    expect(errors).toHaveLength(1)
    expect(errors[0]?.message).toContain("house-style rule 2")
    expect(errors[0]?.message).toContain("docs/effect-house-style.md")
  })

  it.each([
    "@effect/platform-node",
    "@effect/platform-node/NodeRuntime",
    "@effect/opentelemetry",
  ])("allows the sanctioned package %s", (source) => {
    expect(
      runRule(rule, "ImportDeclaration", importDeclaration(source)),
    ).toHaveLength(0)
  })
})
