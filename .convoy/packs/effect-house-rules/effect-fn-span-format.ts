import { defineRule } from "@oxlint/plugins"

import {
  isServiceSpanName,
  isEffectFnCall,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.ts"

export const effectFnSpanFormatRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require Domain.operation Effect.fn span names",
    },
    messages: {
      malformedName:
        "Effect.fn span names are Domain.operation, as in the effect skill: a PascalCase domain, then dotted segments of letters and digits (Domain.Test.operation for a test double). The service itself is named by the tracer's service name, not a prefix.",
      uncheckableName:
        "Effect.fn span names must be static string literals so the span vocabulary stays lint-checkable. Inline the name instead of computing it.",
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
        if (!isServiceSpanName(spanName.value)) {
          context.report({ node: spanName, messageId: "malformedName" })
        }
      },
    }
  },
})
