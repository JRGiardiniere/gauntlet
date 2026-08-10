import { describe, expect, it } from "vitest"
import rule from "./require-ts-extension-imports.js"
import { runRule } from "./test-utils.ts"

const declaration = (type: string, source: string) => ({
  type,
  source: {
    value: source,
    range: [8, 8 + source.length + 2] as [number, number],
  },
})

describe("require-ts-extension-imports", () => {
  describe("imports", () => {
    it("reports an extensionless relative import", () => {
      const errors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "./module"),
      )

      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toBe(
        `Use an explicit ".ts" extension for relative import "./module"`,
      )
    })

    it("reports JavaScript extensions with their TypeScript replacement", () => {
      const jsErrors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "./module.js"),
      )
      const jsxErrors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "./component.jsx"),
      )

      expect(jsErrors[0]?.message).toBe(
        `Use ".ts" extension instead of ".js" for relative imports`,
      )
      expect(jsxErrors[0]?.message).toBe(
        `Use ".tsx" extension instead of ".jsx" for relative imports`,
      )
    })

    it.each([".ts", ".tsx", ".mts", ".cts"])(
      "allows the explicit %s TypeScript extension",
      (extension) => {
        const errors = runRule(
          rule,
          "ImportDeclaration",
          declaration("ImportDeclaration", `./module${extension}`),
        )

        expect(errors).toHaveLength(0)
      },
    )

    it.each([".mjs", ".cjs", ".json"])(
      "allows explicit %s runtime boundary and resource imports",
      (extension) => {
        const errors = runRule(
          rule,
          "ImportDeclaration",
          declaration("ImportDeclaration", `./module${extension}`),
        )

        expect(errors).toHaveLength(0)
      },
    )

    it("allows imports of physical JavaScript plugin files", () => {
      const errors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "./require-ts-extension-imports.js"),
        { filename: import.meta.filename },
      )

      expect(errors).toHaveLength(0)
    })

    it("allows package imports", () => {
      const moduleErrors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "effect/Effect"),
      )
      const javascriptErrors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "some-package/utils.js"),
      )
      const bareErrors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "effect"),
      )

      expect(moduleErrors).toHaveLength(0)
      expect(javascriptErrors).toHaveLength(0)
      expect(bareErrors).toHaveLength(0)
    })

    it.each(["./theme.css", "./banner.svg", "./decoder.wasm", "./notes.txt"])(
      "allows the %s asset import without appending a TypeScript extension",
      (source) => {
        const errors = runRule(
          rule,
          "ImportDeclaration",
          declaration("ImportDeclaration", source),
        )

        expect(errors).toHaveLength(0)
      },
    )

    it("allows resource imports with loader queries", () => {
      const errors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "./schema.sql?raw"),
      )

      expect(errors).toHaveLength(0)
    })

    it("reports deeply nested relative JavaScript imports", () => {
      const errors = runRule(
        rule,
        "ImportDeclaration",
        declaration("ImportDeclaration", "../../lib/utils.js"),
      )

      expect(errors).toHaveLength(1)
      expect(errors[0]?.message).toBe(
        `Use ".ts" extension instead of ".js" for relative imports`,
      )
    })
  })

  it("checks export-all declarations", () => {
    const errors = runRule(
      rule,
      "ExportAllDeclaration",
      declaration("ExportAllDeclaration", "./module"),
    )

    expect(errors).toHaveLength(1)
  })

  it("allows export-all declarations with TypeScript extensions", () => {
    const errors = runRule(
      rule,
      "ExportAllDeclaration",
      declaration("ExportAllDeclaration", "./module.ts"),
    )

    expect(errors).toHaveLength(0)
  })

  it("checks sourced named-export declarations", () => {
    const errors = runRule(
      rule,
      "ExportNamedDeclaration",
      declaration("ExportNamedDeclaration", "./module.js"),
    )

    expect(errors).toHaveLength(1)
  })

  it("allows sourced named exports with TypeScript extensions", () => {
    const errors = runRule(
      rule,
      "ExportNamedDeclaration",
      declaration("ExportNamedDeclaration", "./module.ts"),
    )

    expect(errors).toHaveLength(0)
  })

  it("allows local named-export declarations", () => {
    const errors = runRule(rule, "ExportNamedDeclaration", {
      type: "ExportNamedDeclaration",
      source: null,
    })

    expect(errors).toHaveLength(0)
  })
})
