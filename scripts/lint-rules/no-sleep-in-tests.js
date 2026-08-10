import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.js"

const message =
  "Do not use Effect.sleep in *.test.ts files. Drive the TestClock with TestClock.adjust, or use it.live when real time is the behavior under test — house-style rule 18, docs/effect-house-style.md."

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow Effect.sleep in unit test files",
    },
  },
  create(context) {
    if (
      !isTypeScriptFile(context.filename)
      || !context.filename.endsWith(".test.ts")
    ) {
      return {}
    }

    return {
      MemberExpression(node) {
        if (
          isIdentifier(node.object, "Effect")
          && getPropertyName(node.property) === "sleep"
        ) {
          context.report({ node, message })
        }
      },
    }
  },
}
