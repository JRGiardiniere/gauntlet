import { defineRule } from "@oxlint/plugins"

import {
  isDottedSpanName,
  isEffectFnCall,
  isStringLiteral,
  isTypeScriptFile,
} from "./utils.ts"

interface PrefixOptions {
  readonly prefix?: string
}

const isExemptFile = (filename: string): boolean =>
  /\.(?:test|fake|integration)\.ts$/.test(filename)

const isSanctionedTestSurface = (spanName: string): boolean =>
  spanName.includes(".Fake.") || spanName.includes(".Test.")

export const effectFnPrefixRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Require the project's span prefix on production Effect.fn spans",
    },
    messages: {
      missingPrefix:
        "Production Effect.fn span names must start with {{prefix}}. Rename the span to {{prefix}}.<snake_case_module>.<snake_case_method> — house-style rule 17, docs/effect-house-style.md.",
      missingPrefixOption:
        'house/effect-fn-prefix has no prefix to check this span against. Set the project\'s span prefix in the lint config: "house/effect-fn-prefix": ["error", { "prefix": "<prefix>" }] — house-style rule 17, docs/effect-house-style.md.',
    },
    // A bare "error" reaches the rule with no options at all, which this
    // schema cannot reject; the missingPrefixOption report covers that case.
    schema: [
      {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            pattern: "^[^.]+(?:\\.[^.]+)*$",
            description:
              "The leading span segment(s) every production span must start with, without the trailing dot",
          },
        },
        required: ["prefix"],
        additionalProperties: false,
      },
    ],
  },
  createOnce(context) {
    let prefix: string | undefined
    return {
      before: () => {
        if (
          !isTypeScriptFile(context.filename)
          || isExemptFile(context.filename)
        ) {
          return false
        }
        // SAFETY: oxlint validates rule options against meta.schema when the
        // config loads and rejects the run before any hook fires, so a
        // present option already has PrefixOptions' shape.
        const options = (context.options[0] ?? {}) as PrefixOptions
        prefix = options.prefix
        return true
      },
      CallExpression(node) {
        if (!isEffectFnCall(node)) return

        // Non-literal and non-dotted names are the span-format rule's
        // findings; reporting them here too would double-report one defect.
        const spanName = node.arguments[0]
        if (
          !isStringLiteral(spanName)
          || !isDottedSpanName(spanName.value)
          || isSanctionedTestSurface(spanName.value)
        ) {
          return
        }
        // Without a configured prefix every span would pass unchecked, so
        // each one reports the missing configuration instead.
        if (prefix === undefined) {
          context.report({ node: spanName, messageId: "missingPrefixOption" })
          return
        }
        if (!spanName.value.startsWith(`${prefix}.`)) {
          context.report({
            node: spanName,
            messageId: "missingPrefix",
            data: { prefix },
          })
        }
      },
    }
  },
})
