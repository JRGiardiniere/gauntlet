import {
  getPropertyName,
  isIdentifier,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.js"

const message =
  "Do not inspect an error _tag manually. Use Effect.catchTag, Effect.catchTags, or Predicate.isTagged. House style: docs/effect-house-style.md rule 7."

const errorIdentifier = /^(?:cause|err|error|failure|reason)$/i

const isTagProperty = (node) =>
  isIdentifier(node, "_tag") || (isStringLiteral(node) && node.value === "_tag")

const isErrorTarget = (node) =>
  (isIdentifier(node) && errorIdentifier.test(node.name))
  || (node?.type === "MemberExpression" && errorIdentifier.test(getPropertyName(node.property) ?? ""))

const isErrorTagAccess = (node) =>
  node?.type === "MemberExpression"
  && isTagProperty(node.property)
  && isErrorTarget(node.object)

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
        // Reading _tag for boundary serialization or narrowing an unknown with
        // `"_tag" in value` is licensed; this rule owns tag-value comparisons.
        if (
          ["===", "!==", "==", "!="].includes(node.operator)
          && (isErrorTagAccess(node.left) || isErrorTagAccess(node.right))
        ) {
          context.report({ node, message })
        }
      },
    }
  },
}
