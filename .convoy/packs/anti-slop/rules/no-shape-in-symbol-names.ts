import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

const FORBIDDEN_SYMBOL_NAME = "shape";

function containsForbiddenSymbolName(name: string): boolean {
  return name.toLowerCase().includes(FORBIDDEN_SYMBOL_NAME);
}

/** Return whether an identifier names a statically accessed member or qualified type owned by another value or namespace. */
function isBorrowedMemberName(node: ESTree.Node): boolean {
  const parent = node.parent;
  if (parent === null) return false;
  if (parent.type === "TSQualifiedName") return parent.right === node;
  if (parent.type !== "MemberExpression") return false;
  return parent.property === node && parent.computed === false;
}

/** Return whether a string literal names a property key the way an unquoted identifier would. */
function isQuotedPropertyKey(node: ESTree.StringLiteral): boolean {
  const parent = node.parent;
  return parent !== null && "key" in parent && parent.key === node;
}

/** Ban the case-insensitive substring "shape" in every JavaScript and TypeScript symbol name. */
export const noForbiddenTermInSymbolNamesRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        'Disallow the case-insensitive substring "shape" in JavaScript, TypeScript, private, and JSX symbol names.',
    },
    messages: {
      forbiddenSymbolName:
        'Rename symbol "{{name}}" for its domain role; "shape" describes structure rather than ownership.',
    },
  },
  createOnce(context) {
    // Unrenamed import and export specifiers and shorthand properties visit one
    // source name as two identifiers, so report each start offset once per file.
    const reportedStarts = new Set<number>();

    const report = (node: ESTree.Node, name: string) => {
      if (reportedStarts.has(node.start)) return;
      reportedStarts.add(node.start);
      context.report({
        node,
        messageId: "forbiddenSymbolName",
        data: { name },
      });
    };

    const reportForbiddenSymbolName = (node: ESTree.Node & { name: string }) => {
      if (!containsForbiddenSymbolName(node.name) || isBorrowedMemberName(node)) return;
      report(node, node.name);
    };

    return {
      before() {
        reportedStarts.clear();
      },
      Identifier: reportForbiddenSymbolName,
      PrivateIdentifier: reportForbiddenSymbolName,
      JSXIdentifier: reportForbiddenSymbolName,
      Literal(node) {
        if (typeof node.value !== "string" || !containsForbiddenSymbolName(node.value)) return;
        if (!isQuotedPropertyKey(node)) return;
        report(node, node.value);
      },
    };
  },
});
