import { isIdentifier, isTypeScriptFile, looksLikeTaggedErrorName } from "./utils.js"

const message =
  "Do not use instanceof for tagged errors. Use Effect.catchTag, Effect.catchTags, or a tag predicate. House style: docs/effect-house-style.md rule 7."

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    if (!isTypeScriptFile(context.filename)) return {}

    return {
      BinaryExpression(node) {
        if (node.operator !== "instanceof") return
        if (isIdentifier(node.right) && looksLikeTaggedErrorName(node.right.name)) {
          context.report({ node, message })
        }
      },
    }
  },
}
