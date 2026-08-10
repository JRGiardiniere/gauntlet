import { getPropertyName, isIdentifier, isTypeScriptFile } from "./utils.js"

const isNamedCall = (node, namespace, method) =>
  node?.type === "CallExpression"
  && node.callee?.type === "MemberExpression"
  && isIdentifier(node.callee.object, namespace)
  && getPropertyName(node.callee.property) === method

const isRetryTransientCall = (node) =>
  node?.type === "CallExpression"
  && (
    isIdentifier(node.callee, "retryTransient")
    || (
      node.callee?.type === "MemberExpression"
      && isIdentifier(node.callee.object, "HttpClient")
      && getPropertyName(node.callee.property) === "retryTransient"
    )
  )

const isInlineBoundedSchedule = (node) =>
  node?.type === "CallExpression"
  && node.callee?.type === "MemberExpression"
  && getPropertyName(node.callee.property) === "pipe"
  && isNamedCall(node.callee.object, "Schedule", "spaced")
  && node.arguments.length === 1
  && isNamedCall(node.arguments[0], "Schedule", "take")

const propertyNamed = (options, name) =>
  options.properties.find((property) =>
    property?.type === "Property"
    && getPropertyName(property.key) === name
  )

const isNumericLiteral = (node) =>
  (node?.type === "Literal" || node?.type === "NumericLiteral")
  && typeof node.value === "number"

const message =
  "HttpClient.retryTransient must be explicitly bounded. Set schedule to transientRetrySchedule or Schedule.spaced(...).pipe(Schedule.take(...)), or use a numeric times option by itself — house-style rules 13/23, docs/effect-house-style.md."

export default {
  meta: {
    type: "problem",
    docs: {
      description: "Require bounded transient HTTP retry policies",
    },
  },
  create(context) {
    if (!isTypeScriptFile(context.filename)) return {}

    const boundedSchedules = new Set()
    const retryCalls = []

    const isBoundedOptions = (node) => {
      const options = node.arguments[0]
      if (options?.type !== "ObjectExpression") return false

      const schedule = propertyNamed(options, "schedule")
      if (schedule !== undefined) {
        return (
          isIdentifier(schedule.value, "transientRetrySchedule")
          || isInlineBoundedSchedule(schedule.value)
          || (
            isIdentifier(schedule.value)
            && boundedSchedules.has(schedule.value.name)
          )
        )
      }

      const times = propertyNamed(options, "times")
      return times !== undefined && isNumericLiteral(times.value)
    }

    return {
      ImportSpecifier(node) {
        if (
          getPropertyName(node.imported) === "transientRetrySchedule"
          && isIdentifier(node.local)
        ) {
          boundedSchedules.add(node.local.name)
        }
      },
      VariableDeclarator(node) {
        if (
          isIdentifier(node.id)
          && isInlineBoundedSchedule(node.init)
        ) {
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
            context.report({ node: retryCall, message })
          }
        }
      },
    }
  },
}
