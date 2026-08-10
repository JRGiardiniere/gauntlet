import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.js"

const isProcessEnv = (node) =>
  node?.type === "MemberExpression"
  && isIdentifier(node.object, "process")
  && getPropertyName(node.property) === "env"

const isProcessEnvVariable = (node) =>
  node?.type === "MemberExpression" && isProcessEnv(node.object)

const message =
  "Do not mutate process.env in *.test.ts files. Inject config through test layers or ConfigProvider instead — house-style rule 20, docs/effect-house-style.md."

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow process.env mutation in unit tests",
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
      AssignmentExpression(node) {
        if (isProcessEnvVariable(node.left) || isProcessEnv(node.left)) {
          context.report({ node, message })
        }
      },
      CallExpression(node) {
        if (
          node.callee?.type === "MemberExpression"
          && isIdentifier(node.callee.object, "Object")
          && getPropertyName(node.callee.property) === "assign"
          && isProcessEnv(node.arguments[0])
        ) {
          context.report({ node, message })
        }
      },
      UnaryExpression(node) {
        if (
          node.operator === "delete"
          && isProcessEnvVariable(node.argument)
        ) {
          context.report({ node, message })
        }
      },
    }
  },
}
