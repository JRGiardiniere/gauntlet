// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as fs from "node:fs"
// @effect-diagnostics-next-line nodeBuiltinImport:off
import * as path from "node:path"

import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { isRelativeImport, isTypeScriptFile } from "./utils.ts"

const typescriptExtensions = [".ts", ".tsx", ".mts", ".cts"]
const runtimeBoundaryExtensions = [".mjs", ".cjs", ".json"]
const replacementExtensions = new Map([
  [".js", ".ts"],
  [".jsx", ".tsx"],
])
const javascriptExtensions = [...replacementExtensions.keys()]

const matchingExtension = (
  source: string,
  extensions: ReadonlyArray<string>,
): string | undefined =>
  extensions.find((extension) => source.endsWith(extension))

const resolvesToRuntimeJavaScript = (
  source: string,
  filename: string,
): boolean =>
  matchingExtension(source, javascriptExtensions) !== undefined
  && fs.existsSync(path.resolve(path.dirname(filename), source))

const fixedSource = (source: string): string => {
  const extension = matchingExtension(source, javascriptExtensions)
  if (extension === undefined) return `${source}.ts`
  return `${source.slice(0, -extension.length)}${
    replacementExtensions.get(extension)
  }`
}

export const requireTsExtensionImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require explicit TypeScript extensions on relative module imports",
    },
    messages: {
      missingExtension:
        'Use an explicit ".ts" extension for relative import "{{source}}"',
      javascriptExtension:
        'Use "{{replacement}}" extension instead of "{{extension}}" for relative imports',
    },
    fixable: "code",
  },
  createOnce(context) {
    const checkSource = (source: ESTree.StringLiteral): void => {
      const value = source.value
      if (!isRelativeImport(value)) return
      // Loader-query imports name resources rather than TypeScript modules.
      if (/[?#]/.test(value)) return
      if (matchingExtension(value, typescriptExtensions) !== undefined) return

      // Runtime boundary scripts, plugin files, and data resources do not
      // resolve through TypeScript source paths.
      if (matchingExtension(value, runtimeBoundaryExtensions) !== undefined) {
        return
      }
      // Asset imports (.css, .svg, .wasm, ...) are not TypeScript module
      // paths either.
      const extension = path.extname(value)
      if (extension !== "" && !replacementExtensions.has(extension)) return
      if (resolvesToRuntimeJavaScript(value, context.filename)) return

      const javascriptExtension = matchingExtension(value, javascriptExtensions)
      const replacement = fixedSource(value)
      const diagnostic = javascriptExtension === undefined
        ? { messageId: "missingExtension" as const, data: { source: value } }
        : {
          messageId: "javascriptExtension" as const,
          data: {
            replacement: replacementExtensions.get(javascriptExtension) ?? "",
            extension: javascriptExtension,
          },
        }
      context.report({
        node: source,
        ...diagnostic,
        fix: (fixer) => fixer.replaceTextRange(source.range, `"${replacement}"`),
      })
    }

    return {
      // JavaScript boundary and plugin files must keep runtime-resolvable
      // JavaScript imports.
      before: () => isTypeScriptFile(context.filename),
      ImportDeclaration(node) {
        checkSource(node.source)
      },
      ExportAllDeclaration(node) {
        checkSource(node.source)
      },
      ExportNamedDeclaration(node) {
        if (node.source !== null) checkSource(node.source)
      },
    }
  },
})
