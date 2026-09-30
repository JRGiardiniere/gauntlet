import { defineRule } from "@oxlint/plugins"

import { isTypeScriptFile } from "./utils.ts"

const isSanctionedPlatformImport = (source: string): boolean =>
  source === "@effect/platform-node"
  || source.startsWith("@effect/platform-node/")

const isForbiddenPlatformImport = (source: string): boolean =>
  (source === "@effect/platform"
    || source.startsWith("@effect/platform/")
    || source.startsWith("@effect/platform-"))
  && !isSanctionedPlatformImport(source)

export const noEffectPlatformImportsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow @effect/platform and @effect/platform-bun imports",
    },
    messages: {
      forbiddenPlatform:
        'Do not import "{{source}}"; it is not part of this Effect v4 platform. Use the in-core effect/unstable modules, or @effect/platform-node (the only sanctioned platform package) — house-style rule 2, docs/effect-house-style.md.',
    },
  },
  createOnce(context) {
    return {
      before: () => isTypeScriptFile(context.filename),
      ImportDeclaration(node) {
        const source = node.source.value
        if (isForbiddenPlatformImport(source)) {
          context.report({
            node: node.source,
            messageId: "forbiddenPlatform",
            data: { source },
          })
        }
      },
    }
  },
})
