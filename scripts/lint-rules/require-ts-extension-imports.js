import * as fs from "node:fs"
import * as path from "node:path"
import { isRelativeImport, isTypeScriptFile } from "./utils.js"

const typescriptExtensions = [".ts", ".tsx", ".mts", ".cts"]
const runtimeBoundaryExtensions = [".mjs", ".cjs", ".json"]
const replacementExtensions = new Map([
  [".js", ".ts"],
  [".jsx", ".tsx"],
])

const matchingExtension = (source, extensions) =>
  extensions.find((extension) => source.endsWith(extension))

const resolvesToRuntimeJavaScript = (source, filename) =>
  matchingExtension(source, [...replacementExtensions.keys()]) !== undefined
  && fs.existsSync(path.resolve(path.dirname(filename), source))

const fixedSource = (source) => {
  const extension = matchingExtension(source, [...replacementExtensions.keys()])
  if (extension === undefined) return `${source}.ts`
  return `${source.slice(0, -extension.length)}${replacementExtensions.get(extension)}`
}

const extensionMessage = (source) => {
  const extension = matchingExtension(source, [...replacementExtensions.keys()])
  if (extension === undefined) {
    return `Use an explicit ".ts" extension for relative import "${source}"`
  }
  return `Use "${replacementExtensions.get(extension)}" extension instead of "${extension}" for relative imports`
}

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require explicit TypeScript extensions on relative module imports",
    },
    fixable: "code",
  },
  create(context) {
    // JavaScript boundary and plugin files must keep runtime-resolvable JavaScript imports.
    if (!isTypeScriptFile(context.filename)) return {}

    const checkSource = (source) => {
      const value = source.value
      if (!isRelativeImport(value)) return
      // Loader-query imports name resources rather than TypeScript modules.
      if (/[?#]/.test(value)) return
      if (matchingExtension(value, typescriptExtensions) !== undefined) return

      // Runtime boundary scripts, plugin files, and data resources do not resolve through TypeScript source paths.
      if (matchingExtension(value, runtimeBoundaryExtensions) !== undefined) return
      // Asset imports (.css, .svg, .wasm, ...) are not TypeScript module paths either.
      const extension = path.extname(value)
      if (extension !== "" && !replacementExtensions.has(extension)) return
      if (resolvesToRuntimeJavaScript(value, context.filename)) return

      const replacement = fixedSource(value)
      context.report({
        node: source,
        message: extensionMessage(value),
        fix: (fixer) => fixer.replaceTextRange(source.range, `"${replacement}"`),
      })
    }

    return {
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
}
