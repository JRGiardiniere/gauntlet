import * as fs from "node:fs"
import * as path from "node:path"
import { isRelativeImport } from "./utils.js"

const extensions = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"]

const getModuleName = (specifier) =>
  specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value

const hasIndexFile = (directory) =>
  extensions.some((extension) => fs.existsSync(path.join(directory, `index${extension}`)))

const isIndexImport = (importPath) => {
  const basename = path.basename(importPath)
  return basename === "index" || extensions.some((extension) => basename === `index${extension}`)
}

const resolvesToBarrel = (importSource, currentFile) => {
  if (isIndexImport(importSource)) return true

  const directory = path.dirname(currentFile)
  return hasIndexFile(path.resolve(directory, importSource))
}

const createBarrelMatcher = (options) => {
  const patterns = (options.checkPatterns ?? []).map((pattern) => new RegExp(pattern))
  const checkRelative = options.checkRelativeIndexImports !== false

  return (source, currentFile) => {
    if (isRelativeImport(source)) {
      return checkRelative && resolvesToBarrel(source, currentFile)
    }

    return patterns.some((pattern) => pattern.test(source))
  }
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow imports from barrel files and packages",
    },
    schema: [
      {
        type: "object",
        properties: {
          checkPatterns: {
            type: "array",
            items: { type: "string" },
            description: "Regex patterns matching barrel packages",
          },
          checkRelativeIndexImports: {
            type: "boolean",
            description: "Whether to check relative imports that resolve to index files",
          },
        },
        additionalProperties: false,
      },
    ],
  },
  create(context) {
    const isBarrelImport = createBarrelMatcher(context.options[0] ?? {})

    return {
      ImportDeclaration(node) {
        if (node.importKind === "type") return

        const importSource = node.source.value
        if (!isBarrelImport(importSource, context.filename)) return

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            context.report({
              node: specifier,
              message:
                `Do not use namespace import from barrel file "${importSource}", import from a specific module instead`,
            })
            continue
          }

          if (specifier.type !== "ImportSpecifier" || specifier.importKind === "type") continue

          const moduleName = getModuleName(specifier)
          const localName = specifier.local.name
          const message = isRelativeImport(importSource)
            ? `Do not import "${moduleName}" from barrel file "${importSource}", import from a specific module instead`
            : `Use import * as ${localName} from "${importSource}/${moduleName}" instead`
          context.report({ node: specifier, message })
        }
      },
    }
  },
}
