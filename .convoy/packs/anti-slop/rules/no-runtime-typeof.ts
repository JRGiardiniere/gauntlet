import { defineRule } from "@oxlint/plugins";

import type { ESTree, SourceCode } from "@oxlint/plugins";

import { resolveVariable } from "../shared/scope.ts";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function isInsideTypeGuard(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) {
			return current.returnType?.typeAnnotation.type === "TSTypePredicate";
		}
		current = current.parent;
	}
	return false;
}

/** Return the identifier a member chain such as `globalThis.crypto.subtle` starts from. */
function rootIdentifier(node: ESTree.Expression): ESTree.IdentifierReference | null {
	let current: ESTree.Expression | ESTree.Super = node;
	while (current.type === "MemberExpression" || current.type === "ParenthesizedExpression") {
		current = current.type === "MemberExpression" ? current.object : current.expression;
	}
	return current.type === "Identifier" ? current : null;
}

/** Return whether a declaration is ambient: `declare` on it or on an enclosing `declare global` or `declare module`. */
function isAmbient(node: ESTree.Node): boolean {
	let current: ESTree.Node | null = node;
	while (current !== null && current.type !== "Program") {
		if (current.type === "TSDeclareFunction") return true;
		if ("declare" in current && current.declare === true) return true;
		current = current.parent;
	}
	return false;
}

/** Return whether a binding may be absent at runtime: an undeclared or configured global, or an ambient declaration. */
function isPossiblyAbsent(sourceCode: SourceCode, identifier: ESTree.IdentifierReference): boolean {
	const variable = resolveVariable(sourceCode, identifier);
	if (variable === null) return true;
	return variable.defs.every((definition) => isAmbient(definition.node));
}

/** Return whether typeof safely probes for the existence of a possibly absent binding. */
function isExistenceProbe(sourceCode: SourceCode, node: ESTree.UnaryExpression): boolean {
	const parent = node.parent;
	if (parent.type !== "BinaryExpression") return false;
	if (!["===", "!==", "==", "!="].includes(parent.operator)) return false;
	const other = parent.left === node ? parent.right : parent.left;
	if (other.type !== "Literal" || other.value !== "undefined") return false;
	const root = rootIdentifier(node.argument);
	return root !== null && isPossiblyAbsent(sourceCode, root);
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (
					node.operator === "typeof" &&
					!isExistenceProbe(context.sourceCode, node) &&
					(!allowInTypeGuards || !isInsideTypeGuard(node))
				) {
					context.report({ node, messageId: "runtimeTypeof" });
				}
			},
		};
	},
});
