import { recommended } from "@effect/tsgo/oxlint-presets"

const toCamelCase = (name: string) => name.replaceAll(/-([a-z])/g, (_, letter: string) => letter.toUpperCase())

const toDiagnosticName = (ruleName: string) => toCamelCase(ruleName.slice(ruleName.indexOf("/") + 1))

const toDiagnosticSeverity = (severity: string) => severity === "warn" ? "warning" : severity

const recommendedDiagnosticSeverity = Object.fromEntries(
  Object.entries(recommended.rules ?? {}).map(([ruleName, severity]) => [
    toDiagnosticName(ruleName),
    // The preset types rule entries loosely; at runtime they are severity
    // strings, coerced here at the boundary.
    toDiagnosticSeverity(String(severity)),
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
  // Zero-warning boundary (2026-08-15): every sanctioned occurrence of these
  // carries an inline @effect-diagnostics directive at the site — Promise
  // contracts at the Pi/OverlayFs seams, oxlint plugin code that runs outside
  // the Effect runtime, and tests that deliberately touch the real
  // environment. Blocking severity makes any new occurrence fail the gate
  // instead of joining a standing warning floor.
  asyncFunction: "error",
  newPromise: "error",
  nodeBuiltinImport: "error",
  preferSchemaOverJson: "error",
  preferTypedSchemaDecoder: "error",
  processEnv: "error",
  processEnvInEffect: "error",
}

export const effectDiagnosticsConfig = {
  diagnosticSeverity: effectDiagnosticSeverity,
}

export const effectDiagnosticsConfigJson = JSON.stringify(effectDiagnosticsConfig)
