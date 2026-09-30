import { defineRule } from "@oxlint/plugins"

import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.ts"

const bannedMembers = new Set(["Class", "TaggedClass"])

export const noSchemaClassRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Schema class-based models",
    },
    messages: {
      schemaClass:
        "Schema.{{name}} is banned by the Effect skill's SCHEMA.md (the base layer under docs/effect-house-style.md; no numbered house-style rule covers this). Use plain Schema.Struct models and Data.TaggedError for errors.",
    },
  },
  createOnce(context) {
    return {
      before: () => isTypeScriptFile(context.filename),
      MemberExpression(node) {
        if (!isIdentifier(node.object, "Schema")) return

        const name = getPropertyName(node.property)
        if (name !== undefined && bannedMembers.has(name)) {
          context.report({ node, messageId: "schemaClass", data: { name } })
        }
      },
    }
  },
})
