import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

// The effect family must be pinned to one exact version, but which version is
// the manifest's business — update with `bun add --exact effect@rc` (plus the
// sibling @effect packages), and this check re-verifies the result. `rc` is
// the v4 dist-tag until v4 reaches `latest`.
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
const independentlyVersionedEffectPackages = new Set(["@effect/tsgo"])
const exactVersionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url))
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

const effectPins = dependencyFields.flatMap((field) =>
  Object.entries(manifest[field] ?? {}).flatMap(([name, version]) => {
    if (name !== "effect" && !name.startsWith("@effect/")) return []
    if (independentlyVersionedEffectPackages.has(name)) return []
    return [{ name, version }]
  }),
)

const violations = effectPins.flatMap(({ name, version }) =>
  exactVersionPattern.test(version)
    ? []
    : [`${name} must be an exact version; found ${JSON.stringify(version)}`],
)

const distinctVersions = new Set(effectPins.map(({ version }) => version))
if (violations.length === 0 && distinctVersions.size > 1) {
  violations.push(
    `effect packages must share one version; found ${[...distinctVersions].join(", ")}`,
  )
}

if (effectPins.length === 0) {
  violations.push("expected at least one effect dependency to verify")
}

if (violations.length > 0) {
  console.error("Effect dependency pin check failed:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Effect dependency pins are exact (${[...distinctVersions][0]}).`)
}
