import { defineRule } from "@oxlint/plugins"
import type { Context, ESTree } from "@oxlint/plugins"

import { isTypeScriptFile } from "./utils.ts"

const compact = (value: string): string => value.replaceAll(/\s+/g, "")

const recordValueType = (source: string): string | undefined => {
  const match = /^Record<string,(unknown|any)>$/.exec(compact(source))
  return match?.[1]
}

const indexValueType = (source: string): string | undefined => {
  const match = /^\{?(?:readonly)?\[[^\]]+:string\]:(unknown|any);?\}?$/.exec(
    compact(source),
  )
  return match?.[1]
}

const messageIdFor = (valueType: string) =>
  valueType === "any" ? ("anyRecord" as const) : ("unknownRecord" as const)

const reportType = (
  context: Context,
  node: ESTree.TSIndexSignature | ESTree.TSTypeReference,
  valueType: string | undefined,
): void => {
  if (valueType !== undefined) {
    context.report({ node, messageId: messageIdFor(valueType) })
  }
}

const jsdocRecordPattern = /Record\s*<\s*string\s*,\s*(unknown|any)\s*>/g

const reportJSDocRecords = (context: Context): void => {
  for (const comment of context.sourceCode.getAllComments()) {
    if (comment.type !== "Block" || !comment.value.startsWith("*")) continue

    for (const match of comment.value.matchAll(jsdocRecordPattern)) {
      if (match.index === undefined) continue
      const start = comment.range[0] + 2 + match.index
      const end = start + match[0].length
      context.report({
        loc: {
          start: context.sourceCode.getLocFromIndex(start),
          end: context.sourceCode.getLocFromIndex(end),
        },
        messageId: messageIdFor(match[1]),
      })
    }
  }
}

export const noRecordStringUnknownRule = defineRule({
  meta: {
    type: "suggestion",
    docs: {
      description:
        "Surface unmodeled string-keyed records for explicit type ownership",
    },
    messages: {
      unknownRecord:
        "Record<string, unknown> erases a known shape or leaves input unparsed. Stop and find the authoritative domain type or schema. If none exists, surface the missing model to the user before adding or widening this type.",
      anyRecord:
        "Record<string, any> erases a known shape, leaves input unparsed, and disables type checking. Stop and find the authoritative domain type or schema. If none exists, surface the missing model to the user before adding or widening this type.",
    },
  },
  createOnce(context) {
    return {
      Program() {
        reportJSDocRecords(context)
      },
      // The JSDoc scan covers every file, so the TypeScript gate sits on the
      // type visitors rather than in a before() hook.
      TSTypeReference(node) {
        if (!isTypeScriptFile(context.filename)) return
        reportType(context, node, recordValueType(context.sourceCode.getText(node)))
      },
      TSIndexSignature(node) {
        if (!isTypeScriptFile(context.filename)) return
        reportType(context, node, indexValueType(context.sourceCode.getText(node)))
      },
    }
  },
})
