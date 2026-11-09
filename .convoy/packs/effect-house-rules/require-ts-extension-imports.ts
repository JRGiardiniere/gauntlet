// @effect-diagnostics-next-line nodeBuiltinImport:off -- the rule runs in oxlint under Node and probes the disk
import * as fs from "node:fs"
// @effect-diagnostics-next-line nodeBuiltinImport:off -- the rule runs in oxlint under Node and resolves paths
import * as path from "node:path"

import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { isRelativeImport, isTypeScriptFile } from "./utils.ts"

const typescriptExtensions = [".ts", ".tsx", ".mts", ".cts"] as const
const runtimeBoundaryExtensions = [".mjs", ".cjs", ".json"] as const
// Each JavaScript extension's TypeScript files, in the order TypeScript
// resolves them; the first is the fix when neither is on disk.
const replacementExtensions = {
  ".js": [".ts", ".tsx"],
  ".jsx": [".tsx", ".ts"],
} as const
type JavaScriptExtension = keyof typeof replacementExtensions
const isJavaScriptExtension = (
  extension: string,
): extension is JavaScriptExtension =>
  Object.hasOwn(replacementExtensions, extension)
const javascriptExtensions = Object.keys(replacementExtensions).filter(
  isJavaScriptExtension,
)

const matchingExtension = <Extension extends string>(
  source: string,
  extensions: ReadonlyArray<Extension>,
): Extension | undefined =>
  extensions.find((extension) => source.endsWith(extension))

const resolvesToRuntimeJavaScript = (
  source: string,
  filename: string,
): boolean =>
  matchingExtension(source, javascriptExtensions) !== undefined
  && fs.existsSync(path.resolve(path.dirname(filename), source))

// The fix names the TypeScript file that is actually there (a React component
// is .tsx, whether the import says "./component" or "./component.js"). When
// none is, .js becomes .ts, .jsx becomes .tsx, and no extension becomes .ts.
const fixedSource = (source: string, filename: string): string => {
  const extension = matchingExtension(source, javascriptExtensions)
  const stem = extension === undefined
    ? source
    : source.slice(0, -extension.length)
  const candidates = extension === undefined
    ? typescriptExtensions
    : replacementExtensions[extension]
  const onDisk = candidates.find((candidate) =>
    fs.existsSync(path.resolve(path.dirname(filename), `${stem}${candidate}`))
  )
  return `${stem}${onDisk ?? candidates[0]}`
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
        'Use an explicit "{{extension}}" extension for relative import "{{source}}"',
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
      if (extension !== "" && !isJavaScriptExtension(extension)) return
      if (resolvesToRuntimeJavaScript(value, context.filename)) return

      const javascriptExtension = matchingExtension(value, javascriptExtensions)
      const replacement = fixedSource(value, context.filename)
      const diagnostic = javascriptExtension === undefined
        ? {
          messageId: "missingExtension" as const,
          data: { source: value, extension: path.extname(replacement) },
        }
        : {
          messageId: "javascriptExtension" as const,
          data: {
            replacement: path.extname(replacement),
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
