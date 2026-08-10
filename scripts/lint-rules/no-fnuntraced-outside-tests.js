import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.js"

const isTestFile = (filename) => filename.endsWith(".test.ts")

const message =
  'Effect.fnUntraced is only allowed in *.test.ts files. Use Effect.fn("gauntlet....") for traced surfaces — house-style rule 25, docs/effect-house-style.md.'

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Keep Effect.fnUntraced inside unit test files",
    },
  },
  create(context) {
    if (
      !isTypeScriptFile(context.filename)
      || isTestFile(context.filename)
    ) {
      return {}
    }

    return {
      MemberExpression(node) {
        if (
          isIdentifier(node.object, "Effect")
          && getPropertyName(node.property) === "fnUntraced"
        ) {
          context.report({ node, message })
        }
      },
    }
  },
}
