import { defineRule } from "@oxlint/plugins"
import type { ESTree } from "@oxlint/plugins"

import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.ts"

const isNamedCall = (
  node: ESTree.Argument | ESTree.Expression | null | undefined,
  namespace: string,
  method: string,
): node is ESTree.CallExpression =>
  node?.type === "CallExpression"
  && node.callee.type === "MemberExpression"
  && isIdentifier(node.callee.object, namespace)
  && getPropertyName(node.callee.property) === method

const isRetryTransientCall = (node: ESTree.CallExpression): boolean =>
  isIdentifier(node.callee, "retryTransient")
  || (node.callee.type === "MemberExpression"
    && isIdentifier(node.callee.object, "HttpClient")
    && getPropertyName(node.callee.property) === "retryTransient")

const isInlineBoundedSchedule = (
  node: ESTree.Expression | null | undefined,
): boolean =>
  node?.type === "CallExpression"
  && node.callee.type === "MemberExpression"
  && getPropertyName(node.callee.property) === "pipe"
  && isNamedCall(node.callee.object, "Schedule", "spaced")
  && node.arguments.length === 1
  && isNamedCall(node.arguments[0], "Schedule", "take")

const propertyNamed = (
  options: ESTree.ObjectExpression,
  name: string,
): ESTree.ObjectProperty | undefined =>
  options.properties.find(
    (property): property is ESTree.ObjectProperty =>
      property.type === "Property" && getPropertyName(property.key) === name,
  )

// String and numeric literals share `type: "Literal"`, so the value is the
// only discriminant; the declared guard keeps the `typeof` sanctioned.
const isNumericLiteral = (
  node: ESTree.Expression,
): node is ESTree.NumericLiteral =>
  node.type === "Literal" && typeof node.value === "number"

export const retryScheduleBoundedRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require bounded transient HTTP retry policies",
    },
    messages: {
      unboundedRetry:
        "HttpClient.retryTransient must be explicitly bounded. Set schedule to transientRetrySchedule or Schedule.spaced(...).pipe(Schedule.take(...)), or use a numeric times option by itself — house-style rules 13/23, docs/effect-house-style.md.",
    },
  },
  createOnce(context) {
    let boundedSchedules = new Set<string>()
    let retryCalls: Array<ESTree.CallExpression> = []

    const isBoundedOptions = (node: ESTree.CallExpression): boolean => {
      const options = node.arguments[0]
      if (options?.type !== "ObjectExpression") return false

      const schedule = propertyNamed(options, "schedule")
      if (schedule !== undefined) {
        if (isInlineBoundedSchedule(schedule.value)) return true
        return isIdentifier(schedule.value)
          && (schedule.value.name === "transientRetrySchedule"
            || boundedSchedules.has(schedule.value.name))
      }

      const times = propertyNamed(options, "times")
      return times !== undefined && isNumericLiteral(times.value)
    }

    return {
      before: () => {
        if (!isTypeScriptFile(context.filename)) return false
        boundedSchedules = new Set()
        retryCalls = []
        return true
      },
      ImportSpecifier(node) {
        if (
          getPropertyName(node.imported) === "transientRetrySchedule"
          && isIdentifier(node.local)
        ) {
          boundedSchedules.add(node.local.name)
        }
      },
      VariableDeclarator(node) {
        if (isIdentifier(node.id) && isInlineBoundedSchedule(node.init)) {
          boundedSchedules.add(node.id.name)
        }
      },
      CallExpression(node) {
        if (isRetryTransientCall(node)) {
          retryCalls.push(node)
        }
      },
      "Program:exit"() {
        for (const retryCall of retryCalls) {
          if (!isBoundedOptions(retryCall)) {
            context.report({ node: retryCall, messageId: "unboundedRetry" })
          }
        }
      },
    }
  },
})
