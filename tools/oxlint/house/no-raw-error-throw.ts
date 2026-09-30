import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { isIdentifier, isTypeScriptFile } from "./utils.ts"

const isNewError = (node: ESTree.Expression): boolean =>
  node.type === "NewExpression" && isIdentifier(node.callee, "Error")

export const noRawErrorThrowRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow throwing raw Error objects in Effect code",
    },
    messages: {
      rawErrorThrow:
        "Do not throw raw Error objects in Effect code. Fail with a tagged error. House style: docs/effect-house-style.md rule 7.",
    },
  },
  createOnce(context) {
    return {
      before: () => isTypeScriptFile(context.filename),
      ThrowStatement(node) {
        if (isNewError(node.argument)) {
          context.report({ node, messageId: "rawErrorThrow" })
        }
      },
    }
  },
})
