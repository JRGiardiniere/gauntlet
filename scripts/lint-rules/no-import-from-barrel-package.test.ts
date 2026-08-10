import { describe, expect, it } from "vitest"
import rule from "./no-import-from-barrel-package.js"
import { runRule } from "./test-utils.ts"

const options = {
  filename: "/test/file.ts",
  cwd: "/test",
  ruleOptions: [{ checkPatterns: ["^effect$"] }],
}

const importDeclaration = (
  source: string,
  specifiers: ReadonlyArray<unknown>,
  importKind?: "type" | "value",
) => ({
  type: "ImportDeclaration" as const,
  source: { value: source },
  specifiers,
  ...(importKind === undefined ? {} : { importKind }),
})

const namedSpecifier = (
  name: string,
  local = name,
  importKind?: "type" | "value",
) => ({
  type: "ImportSpecifier" as const,
  imported: { type: "Identifier" as const, name },
  local: { name: local },
  ...(importKind === undefined ? {} : { importKind }),
})

describe("no-import-from-barrel-package", () => {
  it("allows imports from a specific Effect module", () => {
    const node = importDeclaration("effect/Effect", [namedSpecifier("Effect")])

    expect(runRule(rule, "ImportDeclaration", node, options)).toHaveLength(0)
  })

  it("reports every named value imported from an Effect barrel", () => {
    const node = importDeclaration("effect", [
      namedSpecifier("Effect"),
      namedSpecifier("Option"),
      namedSpecifier("Either"),
    ])

    expect(runRule(rule, "ImportDeclaration", node, options)).toHaveLength(3)
  })

  it("suggests the specific module while preserving an alias", () => {
    const node = importDeclaration("effect", [namedSpecifier("Effect", "Eff")])

    expect(runRule(rule, "ImportDeclaration", node, options)[0]?.message).toBe(
      `Use import * as Eff from "effect/Effect" instead`,
    )
  })

  it("allows type-only imports from a barrel", () => {
    const declaration = importDeclaration(
      "effect",
      [namedSpecifier("Effect")],
      "type",
    )
    const specifier = importDeclaration("effect", [
      namedSpecifier("Effect", "Effect", "type"),
    ])

    expect(runRule(rule, "ImportDeclaration", declaration, options)).toHaveLength(0)
    expect(runRule(rule, "ImportDeclaration", specifier, options)).toHaveLength(0)
  })

  it("reports namespace imports from a barrel", () => {
    const node = importDeclaration("effect", [
      {
        type: "ImportNamespaceSpecifier",
        local: { name: "Effect" },
      },
    ])

    expect(runRule(rule, "ImportDeclaration", node, options)[0]?.message).toContain(
      `namespace import from barrel file "effect"`,
    )
  })

  it("allows namespace imports from a specific module", () => {
    const node = importDeclaration("effect/Effect", [
      {
        type: "ImportNamespaceSpecifier",
        local: { name: "Effect" },
      },
    ])

    expect(runRule(rule, "ImportDeclaration", node, options)).toHaveLength(0)
  })

  it("allows default imports", () => {
    const node = importDeclaration("effect", [
      {
        type: "ImportDefaultSpecifier",
        local: { name: "Effect" },
      },
    ])

    expect(runRule(rule, "ImportDeclaration", node, options)).toHaveLength(0)
  })

  it("reports relative index imports by default", () => {
    const node = importDeclaration("./index.ts", [namedSpecifier("value")])

    expect(runRule(rule, "ImportDeclaration", node, options)).toHaveLength(1)
  })

  it("can disable relative index checks", () => {
    const node = importDeclaration("./index.ts", [namedSpecifier("value")])

    expect(runRule(rule, "ImportDeclaration", node, {
      ...options,
      ruleOptions: [{ checkRelativeIndexImports: false }],
    })).toHaveLength(0)
  })

  it("supports additional package patterns", () => {
    const node = importDeclaration("@example/tools", [namedSpecifier("helper")])

    expect(runRule(rule, "ImportDeclaration", node, options)).toHaveLength(0)
    expect(runRule(rule, "ImportDeclaration", node, {
      ...options,
      ruleOptions: [{ checkPatterns: ["^@example/"] }],
    })).toHaveLength(1)
  })

  it("supports an exact package pattern", () => {
    const node = importDeclaration("lodash", [namedSpecifier("map")])

    expect(runRule(rule, "ImportDeclaration", node, options)).toHaveLength(0)
    expect(runRule(rule, "ImportDeclaration", node, {
      ...options,
      ruleOptions: [{ checkPatterns: ["^lodash$"] }],
    })).toHaveLength(1)
  })
})
