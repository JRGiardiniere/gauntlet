import { defineRule } from "@oxlint/plugins"

import {
  getPropertyName,
  isIdentifier,
  isTestFile,
  isTypeScriptFile,
} from "./utils.ts"

export const noFnUntracedOutsideTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Keep Effect.fnUntraced inside unit test files",
    },
    messages: {
      untracedOutsideTests:
        'Effect.fnUntraced is only allowed in *.test.ts files. Use Effect.fn("gauntlet....") for traced surfaces — house-style rule 25, docs/effect-house-style.md.',
    },
  },
  createOnce(context) {
    return {
      before: () =>
        isTypeScriptFile(context.filename) && !isTestFile(context.filename),
      MemberExpression(node) {
        if (
          isIdentifier(node.object, "Effect")
          && getPropertyName(node.property) === "fnUntraced"
        ) {
          context.report({ node, messageId: "untracedOutsideTests" })
        }
      },
    }
  },
})
