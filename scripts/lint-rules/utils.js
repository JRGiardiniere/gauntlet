export const getPropertyName = (node) => {
  if (node?.type === "Identifier" || node?.type === "PrivateIdentifier") return node.name
  if (
    (node?.type === "Literal" || node?.type === "StringLiteral")
    && typeof node.value === "string"
  ) {
    return node.value
  }
  return undefined
}

export const isIdentifier = (node, name) =>
  node?.type === "Identifier" && (name === undefined || node.name === name)

export const isEffectRunMember = (node) =>
  node?.type === "MemberExpression"
  && isIdentifier(node.object, "Effect")
  && /^run[A-Z]/.test(getPropertyName(node.property) ?? "")

export const isDottedSpanName = (value) =>
  /^[^.]+(?:\.[^.]+)+$/.test(value)

export const isEffectFnCall = (node) =>
  node?.type === "CallExpression"
  && node.callee?.type === "MemberExpression"
  && isIdentifier(node.callee.object, "Effect")
  && getPropertyName(node.callee.property) === "fn"

export const isStringLiteral = (node) =>
  (node?.type === "Literal" && typeof node.value === "string")
  || node?.type === "StringLiteral"

export const isTypeScriptFile = (filename) =>
  /\.(?:ts|tsx|mts|cts)$/.test(filename)

export const isRelativeImport = (source) =>
  source.startsWith("./") || source.startsWith("../")

export const looksLikeTaggedErrorName = (name) =>
  typeof name === "string" && name !== "Error" && name.endsWith("Error")
