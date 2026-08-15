// @effect-diagnostics nodeBuiltinImport:off
import * as fs from "node:fs"
import * as path from "node:path"

import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { isRelativeImport } from "./utils.ts"

const extensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
]

const getModuleName = (specifier: ESTree.ImportSpecifier): string =>
  specifier.imported.type === "Identifier"
    ? specifier.imported.name
    : specifier.imported.value

const hasIndexFile = (directory: string): boolean =>
  extensions.some((extension) =>
    fs.existsSync(path.join(directory, `index${extension}`)))

const isIndexImport = (importPath: string): boolean => {
  const basename = path.basename(importPath)
  return basename === "index"
    || extensions.some((extension) => basename === `index${extension}`)
}

const resolvesToBarrel = (
  importSource: string,
  currentFile: string,
): boolean => {
  if (isIndexImport(importSource)) return true

  const directory = path.dirname(currentFile)
  return hasIndexFile(path.resolve(directory, importSource))
}

interface BarrelOptions {
  readonly checkPatterns?: ReadonlyArray<string>
  readonly checkRelativeIndexImports?: boolean
}

const createBarrelMatcher = (options: BarrelOptions) => {
  const patterns = (options.checkPatterns ?? []).map(
    (pattern) => new RegExp(pattern),
  )
  const checkRelative = options.checkRelativeIndexImports !== false

  return (source: string, currentFile: string): boolean => {
    if (isRelativeImport(source)) {
      return checkRelative && resolvesToBarrel(source, currentFile)
    }

    return patterns.some((pattern) => pattern.test(source))
  }
}

export const noImportFromBarrelPackageRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Disallow imports from barrel files and packages",
    },
    messages: {
      namespaceFromBarrel:
        'Do not use namespace import from barrel file "{{importSource}}", import from a specific module instead',
      namedFromBarrelFile:
        'Do not import "{{moduleName}}" from barrel file "{{importSource}}", import from a specific module instead',
      namedFromBarrelPackage:
        'Use import * as {{localName}} from "{{importSource}}/{{moduleName}}" instead',
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
            description:
              "Whether to check relative imports that resolve to index files",
          },
        },
        additionalProperties: false,
      },
    ],
    defaultOptions: [{}],
  },
  createOnce(context) {
    let isBarrelImport: ReturnType<typeof createBarrelMatcher> = () => false
    return {
      before: () => {
        // SAFETY: oxlint validates rule options against meta.schema when the
        // config loads and rejects the run before any hook fires, so a
        // present option already has BarrelOptions' shape.
        const options = (context.options[0] ?? {}) as BarrelOptions
        isBarrelImport = createBarrelMatcher(options)
      },
      ImportDeclaration(node) {
        if (node.importKind === "type") return

        const importSource = node.source.value
        if (!isBarrelImport(importSource, context.filename)) return

        for (const specifier of node.specifiers) {
          if (specifier.type === "ImportNamespaceSpecifier") {
            context.report({
              node: specifier,
              messageId: "namespaceFromBarrel",
              data: { importSource },
            })
            continue
          }

          if (
            specifier.type !== "ImportSpecifier"
            || specifier.importKind === "type"
          ) {
            continue
          }

          const moduleName = getModuleName(specifier)
          if (isRelativeImport(importSource)) {
            context.report({
              node: specifier,
              messageId: "namedFromBarrelFile",
              data: { moduleName, importSource },
            })
          } else {
            context.report({
              node: specifier,
              messageId: "namedFromBarrelPackage",
              data: { localName: specifier.local.name, importSource, moduleName },
            })
          }
        }
      },
    }
  },
})
