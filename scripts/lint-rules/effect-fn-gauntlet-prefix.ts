import { defineRule } from "@oxlint/plugins"

import {
  isDottedSpanName,
  isEffectFnCall,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.ts"

const isExemptFile = (filename: string): boolean =>
  /\.(?:test|fake|integration)\.ts$/.test(filename)

const isSanctionedTestSurface = (spanName: string): boolean =>
  spanName.includes(".Fake.") || spanName.includes(".Test.")

export const effectFnGauntletPrefixRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require the gauntlet prefix on production Effect.fn spans",
    },
    messages: {
      missingPrefix:
        "Production Effect.fn span names must start with gauntlet. Rename the span to gauntlet.<snake_case_module>.<snake_case_method> — house-style rule 17, docs/effect-house-style.md.",
    },
  },
  createOnce(context) {
    return {
      before: () =>
        isTypeScriptFile(context.filename) && !isExemptFile(context.filename),
      CallExpression(node) {
        if (!isEffectFnCall(node)) return

        // Non-literal and non-dotted names are the span-format rule's
        // findings; reporting them here too would double-report one defect.
        const spanName = node.arguments[0]
        if (
          isStringLiteral(spanName)
          && isDottedSpanName(spanName.value)
          && !spanName.value.startsWith("gauntlet.")
          && !isSanctionedTestSurface(spanName.value)
        ) {
          context.report({ node: spanName, messageId: "missingPrefix" })
        }
      },
    }
  },
})
