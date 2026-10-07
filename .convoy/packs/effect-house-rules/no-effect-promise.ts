import { defineRule } from "@oxlint/plugins"

import {
  getPropertyName,
  isIdentifier,
  isTestFile,
  isTypeScriptFile,
} from "./utils.ts"

export const noEffectPromiseRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Bridge a Promise with Effect.tryPromise and a typed error",
    },
    messages: {
      effectPromise:
        "Use Effect.tryPromise with a typed error: a rejection inside Effect.promise becomes an untyped defect. Effect.promise is only for a Promise built never to reject, with a disable comment giving the reason.",
    },
  },
  createOnce(context) {
    return {
      before: () =>
        isTypeScriptFile(context.filename) && !isTestFile(context.filename),
      MemberExpression(node) {
        if (
          isIdentifier(node.object, "Effect")
          && getPropertyName(node.property) === "promise"
        ) {
          context.report({ node, messageId: "effectPromise" })
        }
      },
    }
  },
})
