import { defineRule } from "@oxlint/plugins"

// A comment that turns a check off: oxlint's and ESLint's disable comments,
// and the Effect language service's `@effect-diagnostics` overrides.
const suppression = /^\s*(?:(?:oxlint|eslint)-disable(?:-next-line|-line)?|@effect-diagnostics(?:-next-line)?)\b/

// The reason follows ` -- ` and must say something.
const reason = /\s--\s+\S/

// An Effect override that only sets checks to `error` makes them stricter, not
// quieter, so it needs no reason. Any other severity can lower a check.
const raisesOnly = /^\s*@effect-diagnostics(?:-next-line)?(?:\s+[\w*-]+:error)+\s*$/

export const directiveReasonRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description: "Give every comment that turns a check off a reason after `--`",
    },
    messages: {
      missingReason:
        "Say why this check is off, after ` -- ` on the same comment (`// oxlint-disable-next-line <rule> -- <reason>`): the next reader can't tell a deliberate exception from a shortcut otherwise.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          if (suppression.test(comment.value) && !reason.test(comment.value) && !raisesOnly.test(comment.value)) {
            context.report({ loc: comment.loc, messageId: "missingReason" })
          }
        }
      },
    }
  },
})
