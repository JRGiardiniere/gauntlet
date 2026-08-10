import { recommended } from "@effect/tsgo/oxlint-presets"

const toCamelCase = (name) => name.replaceAll(/-([a-z])/g, (_, letter) => letter.toUpperCase())

const toDiagnosticName = (ruleName) => toCamelCase(ruleName.slice(ruleName.indexOf("/") + 1))

const toDiagnosticSeverity = (severity) => severity === "warn" ? "warning" : severity

const recommendedDiagnosticSeverity = Object.fromEntries(
  Object.entries(recommended.rules).map(([ruleName, severity]) => [
    toDiagnosticName(ruleName),
    toDiagnosticSeverity(severity),
  ]),
)

// These official rules fully replace clean gauntlet rules and retain their blocking
// severity.
export const effectDiagnosticSeverity = {
  ...recommendedDiagnosticSeverity,
  extendsNativeError: "error",
  outdatedApi: "error",
  unnecessaryFailYieldableError: "error",
  // These production correctness rules stay blocking after their accepted
  // scope is clean.
  globalDateInEffect: "error",
  globalRandomInEffect: "error",
}

export const effectDiagnosticsConfig = {
  diagnosticSeverity: effectDiagnosticSeverity,
}

export const effectDiagnosticsConfigJson = JSON.stringify(effectDiagnosticsConfig)
