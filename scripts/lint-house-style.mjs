import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const repoRoot = fileURLToPath(new URL("..", import.meta.url))
const oxlint = fileURLToPath(new URL("../node_modules/.bin/oxlint", import.meta.url))
const extraLintTargets = process.argv.slice(2)
const oxlintFormat = process.env.CI === undefined ? "default" : "github"

const checks = [
  {
    name: "oxlint",
    command: oxlint,
    args: ["--config", ".oxlintrc.json", "--format", oxlintFormat, "src", "scripts", ...extraLintTargets],
  },
  {
    name: "unknown record early warning",
    command: oxlint,
    args: [
      "--config",
      ".oxlintrc.unknown-record.json",
      "--format",
      oxlintFormat,
      "src",
      "scripts",
      ...extraLintTargets,
    ],
  },
  {
    name: "official Effect diagnostics",
    command: process.execPath,
    args: ["scripts/lint-effect-diagnostics.mjs"],
  },
  {
    name: "Effect dependency pins",
    command: process.execPath,
    args: ["scripts/check-effect-pin.mjs"],
  },
  {
    name: "import cycles",
    command: process.execPath,
    args: ["scripts/check-import-cycles.mjs"],
  },
]

let failed = false

for (const check of checks) {
  console.log(`\n[house-style] ${check.name}`)
  const result = spawnSync(check.command, check.args, {
    cwd: repoRoot,
    stdio: "inherit",
  })

  if (result.error !== undefined) throw result.error
  if (result.status !== 0) failed = true
}

process.exitCode = failed ? 1 : 0
