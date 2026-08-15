import { defineRule } from "@oxlint/plugins"

import {
  isDottedSpanName,
  isEffectFnCall,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.ts"

export const effectFnSpanFormatRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require dotted Effect.fn span names",
    },
    messages: {
      malformedName:
        "Effect.fn span names must have dotted, non-empty segments (production spans: gauntlet.<snake_case_module>.<snake_case_method>) — house-style rules 17/25, docs/effect-house-style.md.",
      uncheckableName:
        "Effect.fn span names must be static string literals so the span vocabulary stays lint-checkable. Inline the name instead of computing it — house-style rules 17/25, docs/effect-house-style.md.",
    },
  },
  createOnce(context) {
    return {
      before: () => isTypeScriptFile(context.filename),
      CallExpression(node) {
        if (!isEffectFnCall(node)) return

        const spanName = node.arguments[0]
        if (!isStringLiteral(spanName)) {
          context.report({
            node: spanName ?? node,
            messageId: "uncheckableName",
          })
          return
        }
        if (!isDottedSpanName(spanName.value)) {
          context.report({ node: spanName, messageId: "malformedName" })
        }
      },
    }
  },
})
