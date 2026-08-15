import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import {
  getPropertyName,
  isIdentifier,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.ts"

const errorIdentifier = /^(?:cause|err|error|failure|reason)$/i

const isTagProperty = (
  node: ESTree.Expression | ESTree.IdentifierName | ESTree.PrivateIdentifier,
): boolean =>
  isIdentifier(node, "_tag") || (isStringLiteral(node) && node.value === "_tag")

const isErrorTarget = (node: ESTree.Expression): boolean =>
  (isIdentifier(node) && errorIdentifier.test(node.name))
  || (node.type === "MemberExpression"
    && errorIdentifier.test(getPropertyName(node.property) ?? ""))

const isErrorTagAccess = (node: ESTree.Expression): boolean =>
  node.type === "MemberExpression"
  && isTagProperty(node.property)
  && isErrorTarget(node.object)

export const noManualTagCheckRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow manual _tag comparisons on errors",
    },
    messages: {
      manualTagCheck:
        "Do not inspect an error _tag manually. Use Effect.catchTag, Effect.catchTags, or Predicate.isTagged. House style: docs/effect-house-style.md rule 7.",
    },
  },
  createOnce(context) {
    return {
      before: () => isTypeScriptFile(context.filename),
      BinaryExpression(node) {
        // Reading _tag for boundary serialization or narrowing an unknown with
        // `"_tag" in value` is licensed; this rule owns tag-value comparisons.
        if (
          ["===", "!==", "==", "!="].includes(node.operator)
          && (isErrorTagAccess(node.left) || isErrorTagAccess(node.right))
        ) {
          context.report({ node, messageId: "manualTagCheck" })
        }
      },
    }
  },
})
