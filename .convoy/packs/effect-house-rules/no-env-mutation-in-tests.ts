import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import {
  getPropertyName,
  type InspectedNode,
  isIdentifier,
  isTestFile,
} from "./utils.ts"

const isProcessEnv = (
  node: InspectedNode | null | undefined,
): node is ESTree.MemberExpression =>
  node?.type === "MemberExpression"
  && isIdentifier(node.object, "process")
  && getPropertyName(node.property) === "env"

const isProcessEnvVariable = (
  node: InspectedNode | null | undefined,
): node is ESTree.MemberExpression =>
  node?.type === "MemberExpression" && isProcessEnv(node.object)

export const noEnvMutationInTestsRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Disallow process.env mutation in unit tests",
    },
    messages: {
      envMutation:
        "Do not mutate process.env in *.test.ts files. Inject config through test layers or ConfigProvider instead — house-style rule 20, docs/effect-house-style.md.",
    },
  },
  createOnce(context) {
    return {
      before: () => isTestFile(context.filename),
      AssignmentExpression(node) {
        if (isProcessEnvVariable(node.left) || isProcessEnv(node.left)) {
          context.report({ node, messageId: "envMutation" })
        }
      },
      CallExpression(node) {
        if (
          node.callee.type === "MemberExpression"
          && isIdentifier(node.callee.object, "Object")
          && getPropertyName(node.callee.property) === "assign"
          && isProcessEnv(node.arguments[0])
        ) {
          context.report({ node, messageId: "envMutation" })
        }
      },
      UnaryExpression(node) {
        if (node.operator === "delete" && isProcessEnvVariable(node.argument)) {
          context.report({ node, messageId: "envMutation" })
        }
      },
    }
  },
})
