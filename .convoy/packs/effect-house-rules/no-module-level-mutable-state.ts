import { defineRule } from "@oxlint/plugins"

import { isTestFile, isTypeScriptFile } from "./utils.ts"

export const noModuleLevelMutableStateRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Keep `let` and `var` out of module scope",
    },
    messages: {
      moduleLevelMutable:
        "A module-level `{{kind}}` is shared by every request the process or isolate serves, so one request's value leaks into the next. Keep the state in a service or Layer, or in the function that uses it.",
    },
  },
  createOnce(context) {
    return {
      before: () =>
        isTypeScriptFile(context.filename) && !isTestFile(context.filename),
      VariableDeclaration(node) {
        // `declare var` only describes a global that exists elsewhere.
        if ((node.kind !== "let" && node.kind !== "var") || node.declare === true) return
        const parent = node.parent
        const atModuleScope =
          parent.type === "Program"
          || (parent.type === "ExportNamedDeclaration" && parent.parent.type === "Program")

        if (atModuleScope) {
          context.report({ node, messageId: "moduleLevelMutable", data: { kind: node.kind } })
        }
      },
    }
  },
})
