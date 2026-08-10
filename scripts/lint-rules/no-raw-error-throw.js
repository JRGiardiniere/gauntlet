import { isIdentifier, isTypeScriptFile } from "./utils.js"

const message =
  "Do not throw raw Error objects in Effect code. Fail with a tagged error. House style: docs/effect-house-style.md rule 7."

const isNewError = (node) =>
  node?.type === "NewExpression" && isIdentifier(node.callee, "Error")

export default {
  meta: {
    type: "problem",
    docs: {
      description: message,
    },
  },
  create(context) {
    if (!isTypeScriptFile(context.filename)) return {}

    return {
      ThrowStatement(node) {
        if (isNewError(node.argument)) {
          context.report({ node, message })
        }
      },
    }
  },
}
