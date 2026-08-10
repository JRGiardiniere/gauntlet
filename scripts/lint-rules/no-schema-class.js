import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.js"

const bannedMembers = new Set(["Class", "TaggedClass"])

const messageFor = (name) =>
  `Schema.${name} is banned by the Effect skill's SCHEMA.md (the base layer under docs/effect-house-style.md; no numbered house-style rule covers this). Use plain Schema.Struct models and Data.TaggedError for errors.`

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Schema class-based models",
    },
  },
  create(context) {
    if (!isTypeScriptFile(context.filename)) return {}

    return {
      MemberExpression(node) {
        if (!isIdentifier(node.object, "Schema")) return

        const name = getPropertyName(node.property)
        if (bannedMembers.has(name)) {
          context.report({ node, message: messageFor(name) })
        }
      },
    }
  },
}
