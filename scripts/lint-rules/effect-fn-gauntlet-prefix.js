import {
  isDottedSpanName,
  isEffectFnCall,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.js"

const isExemptFile = (filename) =>
  /\.(?:test|fake|integration)\.ts$/.test(filename)

const isSanctionedTestSurface = (spanName) =>
  spanName.includes(".Fake.") || spanName.includes(".Test.")

const message =
  "Production Effect.fn span names must start with gauntlet. Rename the span to gauntlet.<snake_case_module>.<snake_case_method> — house-style rule 17, docs/effect-house-style.md."

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require the gauntlet prefix on production Effect.fn spans",
    },
  },
  create(context) {
    if (
      !isTypeScriptFile(context.filename)
      || isExemptFile(context.filename)
    ) {
      return {}
    }

    return {
      CallExpression(node) {
        if (!isEffectFnCall(node)) return

        // Non-literal and non-dotted names are effect-fn-span-shape's findings;
        // reporting them here too would double-report one defect.
        const spanName = node.arguments[0]
        if (
          isStringLiteral(spanName)
          && isDottedSpanName(spanName.value)
          && !spanName.value.startsWith("gauntlet.")
          && !isSanctionedTestSurface(spanName.value)
        ) {
          context.report({ node: spanName, message })
        }
      },
    }
  },
}
