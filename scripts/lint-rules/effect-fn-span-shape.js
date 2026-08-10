import {
  isDottedSpanName,
  isEffectFnCall,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.js"

const shapeMessage =
  "Effect.fn span names must have dotted, non-empty segments (production spans: gauntlet.<snake_case_module>.<snake_case_method>) — house-style rules 17/25, docs/effect-house-style.md."

const literalMessage =
  "Effect.fn span names must be static string literals so the span vocabulary stays lint-checkable. Inline the name instead of computing it — house-style rules 17/25, docs/effect-house-style.md."

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require dotted Effect.fn span names",
    },
  },
  create(context) {
    if (!isTypeScriptFile(context.filename)) return {}

    return {
      CallExpression(node) {
        if (!isEffectFnCall(node)) return

        const spanName = node.arguments[0]
        if (!isStringLiteral(spanName)) {
          context.report({ node: spanName ?? node, message: literalMessage })
          return
        }
        if (!isDottedSpanName(spanName.value)) {
          context.report({ node: spanName, message: shapeMessage })
        }
      },
    }
  },
}
