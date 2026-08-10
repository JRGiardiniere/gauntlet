import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const expectedVersion = "4.0.0-beta.106"
const dependencyFields = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]
const independentlyVersionedEffectPackages = new Set(["@effect/tsgo"])

const manifestPath = fileURLToPath(new URL("../package.json", import.meta.url))
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))

const violations = dependencyFields.flatMap((field) =>
  Object.entries(manifest[field] ?? {}).flatMap(([name, version]) => {
    if (name !== "effect" && !name.startsWith("@effect/")) return []
    if (independentlyVersionedEffectPackages.has(name)) return []
    if (version === expectedVersion) return []

    return [
      `${name} must be exactly ${expectedVersion}; found ${JSON.stringify(version)}`,
    ]
  }),
)

if (violations.length > 0) {
  console.error("Effect dependency pin check failed:")
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log(`Effect dependency pins are exact (${expectedVersion}).`)
}
