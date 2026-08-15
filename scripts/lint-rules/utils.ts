import type { ESTree } from "@oxlint/plugins"

// Property positions carry IdentifierName; expression positions carry
// IdentifierReference; declarations carry BindingIdentifier. All discriminate
// on `type: "Identifier"` and expose `name`.
type NamedIdentifier =
  | ESTree.BindingIdentifier
  | ESTree.IdentifierName
  | ESTree.IdentifierReference

// The AST positions the helpers below inspect: expressions, property keys,
// module export names, assignment targets, and binding patterns.
export type InspectedNode =
  | ESTree.Argument
  | ESTree.AssignmentTarget
  | ESTree.BindingPattern
  | ESTree.Expression
  | ESTree.ModuleExportName
  | ESTree.PrivateIdentifier
  | ESTree.PropertyKey

export const isIdentifier = (
  node: InspectedNode | null | undefined,
  name?: string,
): node is NamedIdentifier =>
  node?.type === "Identifier" && (name === undefined || node.name === name)

// The one sanctioned `typeof`: string and numeric literals share
// `type: "Literal"`, so the value itself is the only discriminant. The check
// lives in a declared type guard, which anti-slop's no-runtime-typeof admits
// under allowInTypeGuards.
export const isStringLiteral = (
  node: InspectedNode | null | undefined,
): node is ESTree.StringLiteral =>
  node?.type === "Literal" && typeof node.value === "string"

export const getPropertyName = (
  node: InspectedNode | null | undefined,
): string | undefined => {
  if (node?.type === "Identifier" || node?.type === "PrivateIdentifier") {
    return node.name
  }
  if (isStringLiteral(node)) return node.value
  return undefined
}

export const isDottedSpanName = (value: string): boolean =>
  /^[^.]+(?:\.[^.]+)+$/.test(value)

export const isEffectFnCall = (
  node: ESTree.Expression | null | undefined,
): node is ESTree.CallExpression =>
  node?.type === "CallExpression"
  && node.callee.type === "MemberExpression"
  && isIdentifier(node.callee.object, "Effect")
  && getPropertyName(node.callee.property) === "fn"

export const isTypeScriptFile = (filename: string): boolean =>
  /\.(?:ts|tsx|mts|cts)$/.test(filename)

export const isTestFile = (filename: string): boolean =>
  filename.endsWith(".test.ts")

export const isRelativeImport = (source: string): boolean =>
  source.startsWith("./") || source.startsWith("../")

export const looksLikeTaggedErrorName = (name: string): boolean =>
  name !== "Error" && name.endsWith("Error")
