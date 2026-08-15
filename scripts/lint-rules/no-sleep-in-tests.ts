import { defineRule } from "@oxlint/plugins"

import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.ts"

export const noSleepInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect.sleep in unit test files",
    },
    messages: {
      sleepInTest:
        "Do not use Effect.sleep in *.test.ts files. Drive the TestClock with TestClock.adjust, or use it.live when real time is the behavior under test — house-style rule 18, docs/effect-house-style.md.",
    },
  },
  createOnce(context) {
    return {
      before: () =>
        isTypeScriptFile(context.filename)
        && context.filename.endsWith(".test.ts"),
      MemberExpression(node) {
        if (
          isIdentifier(node.object, "Effect")
          && getPropertyName(node.property) === "sleep"
        ) {
          context.report({ node, messageId: "sleepInTest" })
        }
      },
    }
  },
})
