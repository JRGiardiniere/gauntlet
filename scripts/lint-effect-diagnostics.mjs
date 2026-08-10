import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { effectDiagnosticsConfigJson } from "./effect-diagnostics-config.mjs"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const effectTsgo = fileURLToPath(new URL("../node_modules/.bin/effect-tsgo", import.meta.url))
const format = process.env.CI === undefined ? "pretty" : "github-actions"

const projects = ["tsconfig.json"]

let failed = false

for (const project of projects) {
  console.log(`\n[effect-diagnostics] ${project}`)
  const result = spawnSync(effectTsgo, [
    "diagnostics",
    "--project",
    project,
    "--format",
    format,
    "--lspconfig",
    effectDiagnosticsConfigJson,
  ], {
    cwd: repoRoot,
    stdio: "inherit",
  })

  if (result.error !== undefined) throw result.error
  if (result.status !== 0) failed = true
}

process.exitCode = failed ? 1 : 0
