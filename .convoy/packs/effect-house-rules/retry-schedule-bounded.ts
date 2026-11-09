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

// `HttpClient.<method>(...)`, or the method imported and called bare.
const isHttpClientCall = (node: ESTree.CallExpression, method: string): boolean =>
  isIdentifier(node.callee, method)
  || (node.callee.type === "MemberExpression"
    && isIdentifier(node.callee.object, "HttpClient")
    && getPropertyName(node.callee.property) === method)

const isInlineBoundedSchedule = (
  node: ESTree.Expression | null | undefined,
): boolean =>
  node?.type === "CallExpression"
  && node.callee.type === "MemberExpression"
  && getPropertyName(node.callee.property) === "pipe"
  && isNamedCall(node.callee.object, "Schedule", "spaced")
  && node.arguments.length === 1
  && isNamedCall(node.arguments[0], "Schedule", "upTo")

const propertyNamed = (
  options: ESTree.ObjectExpression,
  name: string,
): ESTree.ObjectProperty | undefined =>
  options.properties.find(
    (property): property is ESTree.ObjectProperty =>
      property.type === "Property" && getPropertyName(property.key) === name,
  )

// String and numeric literals share `type: "Literal"`, so the value is the
// only discriminant.
const isNumericLiteral = (
  node: ESTree.Expression,
): node is ESTree.NumericLiteral =>
  node.type === "Literal" && typeof node.value === "number"

const hasNumericTimes = (options: ESTree.ObjectExpression): boolean => {
  const times = propertyNamed(options, "times")
  return times !== undefined && isNumericLiteral(times.value)
}

// withRateLimiter retries a 429 forever unless `times` is set. Its options
// come last, whether it's called data-first or data-last.
const isBoundedRateLimiter = (node: ESTree.CallExpression): boolean => {
  const options = node.arguments.at(-1)
  return options?.type === "ObjectExpression" && hasNumericTimes(options)
}

export const retryScheduleBoundedRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description: "Require bounded HTTP retry policies",
    },
    messages: {
      unboundedRetry:
        "HttpClient.retryTransient must be explicitly bounded. Set schedule to transientRetrySchedule or Schedule.spaced(...).pipe(Schedule.upTo({ times: n })), or cap any schedule with a numeric times option, as the effect skill says.",
      unboundedRateLimiter:
        "HttpClient.withRateLimiter retries a 429 forever unless times is set. Give its options a numeric times (0 returns the first 429).",
    },
  },
  createOnce(context) {
    let boundedSchedules = new Set<string>()
    let retryCalls: Array<ESTree.CallExpression> = []
    let rateLimiterCalls: Array<ESTree.CallExpression> = []

    const isBoundedOptions = (node: ESTree.CallExpression): boolean => {
      const options = node.arguments[0]
      if (options?.type !== "ObjectExpression") return false

      // buildFromOptions wraps any supplied schedule in an attempt cap when
      // `times` is set, so a numeric times bounds the retry on its own.
      if (hasNumericTimes(options)) return true

      const schedule = propertyNamed(options, "schedule")
      if (schedule === undefined) return false
      if (isInlineBoundedSchedule(schedule.value)) return true
      return isIdentifier(schedule.value)
        && (schedule.value.name === "transientRetrySchedule"
          || boundedSchedules.has(schedule.value.name))
    }

    return {
      before: () => {
        if (!isTypeScriptFile(context.filename)) return false
        boundedSchedules = new Set()
        retryCalls = []
        rateLimiterCalls = []
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
        if (isHttpClientCall(node, "retryTransient")) retryCalls.push(node)
        if (isHttpClientCall(node, "withRateLimiter")) rateLimiterCalls.push(node)
      },
      "Program:exit"() {
        for (const retryCall of retryCalls) {
          if (!isBoundedOptions(retryCall)) {
            context.report({ node: retryCall, messageId: "unboundedRetry" })
          }
        }
        for (const rateLimiterCall of rateLimiterCalls) {
          if (!isBoundedRateLimiter(rateLimiterCall)) {
            context.report({ node: rateLimiterCall, messageId: "unboundedRateLimiter" })
          }
        }
      },
    }
  },
})
