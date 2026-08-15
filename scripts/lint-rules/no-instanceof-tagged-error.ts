import { defineRule } from "@oxlint/plugins"

import {
  isIdentifier,
  isTypeScriptFile,
  looksLikeTaggedErrorName,
} from "./utils.ts"

export const noInstanceofTaggedErrorRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow instanceof checks against tagged errors",
    },
    messages: {
      instanceofTaggedError:
        "Do not use instanceof for tagged errors. Use Effect.catchTag, Effect.catchTags, or a tag predicate. House style: docs/effect-house-style.md rule 7.",
    },
  },
  createOnce(context) {
    return {
      before: () => isTypeScriptFile(context.filename),
      BinaryExpression(node) {
        if (node.operator !== "instanceof") return
        if (
          isIdentifier(node.right)
          && looksLikeTaggedErrorName(node.right.name)
        ) {
          context.report({ node, messageId: "instanceofTaggedError" })
        }
      },
    }
  },
})
