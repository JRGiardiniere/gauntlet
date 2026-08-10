import { isTypeScriptFile } from "./utils.js"

const unknownMessage =
  "Record<string, unknown> erases a known shape or leaves input unparsed. Stop and find the authoritative domain type or schema. If none exists, surface the missing model to the user before adding or widening this type."

const anyMessage =
  "Record<string, any> erases a known shape, leaves input unparsed, and disables type checking. Stop and find the authoritative domain type or schema. If none exists, surface the missing model to the user before adding or widening this type."

const compact = (value) => value.replaceAll(/\s+/g, "")

const recordValueType = (source) => {
  const match = /^Record<string,(unknown|any)>$/.exec(compact(source))
  return match?.[1]
}

const indexValueType = (source) => {
  const match = /^\{?(?:readonly)?\[[^\]]+:string\]:(unknown|any);?\}?$/.exec(compact(source))
  return match?.[1]
}

const messageFor = (valueType) => valueType === "any" ? anyMessage : unknownMessage

const reportType = (context, node, valueType) => {
  if (valueType !== undefined) context.report({ node, message: messageFor(valueType) })
}

const jsdocRecordPattern = /Record\s*<\s*string\s*,\s*(unknown|any)\s*>/g

const reportJSDocRecords = (context) => {
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
        message: messageFor(match[1]),
      })
    }
  }
}

export default {
  meta: {
    type: "suggestion",
    docs: {
      description: "Surface unmodeled string-keyed records for explicit type ownership",
    },
  },
  create(context) {
    const sourceOf = (node) => context.sourceCode.getText(node)
    const visitors = {
      Program() {
        reportJSDocRecords(context)
      },
    }

    if (isTypeScriptFile(context.filename)) {
      visitors.TSTypeReference = (node) => {
        reportType(context, node, recordValueType(sourceOf(node)))
      }
      visitors.TSIndexSignature = (node) => {
        reportType(context, node, indexValueType(sourceOf(node)))
      }
    }

    return visitors
  },
}
