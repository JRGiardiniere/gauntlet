// The Effect-pin gate's runMain boundary. The effect family must be pinned to
// one exact version, but which version is the manifest's business: it follows
// the `effect` that @opencode/sdk depends on, so Gauntlet and OpenCode share
// one copy. The manifest's `overrides` pin the same version for transitive
// dependents, and bun.lock must resolve exactly one `effect`. Update Effect,
// its sibling @effect packages and the overrides together; this check
// re-verifies the result.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
  "overrides",
] as const
const independentlyVersionedEffectPackages = new Set(["@effect/tsgo"])
const exactVersionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const quoted = Schema.encodeSync(Schema.fromJsonString(Schema.String))

const DependencyMap = Schema.Record(Schema.String, Schema.String)
const Manifest = Schema.fromJsonString(Schema.Struct({
  dependencies: Schema.optional(DependencyMap),
  devDependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
  optionalDependencies: Schema.optional(DependencyMap),
  overrides: Schema.optional(DependencyMap),
}))

// Every resolved effect package in bun.lock, as `"effect@<version>"`.
const lockedEffectPattern = /"effect@([^"]+)"/g

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const source = yield* fs.readFileString(`${import.meta.dirname}/../package.json`)
  const manifest = yield* Schema.decodeEffect(Manifest)(source)
  const lockfile = yield* fs.readFileString(`${import.meta.dirname}/../bun.lock`)

  const effectPins = Array.flatMap(dependencyFields, (field) =>
    Array.flatMap(Record.toEntries(manifest[field] ?? {}), ([name, version]) => {
      if (name !== "effect" && !name.startsWith("@effect/")) return []
      if (independentlyVersionedEffectPackages.has(name)) return []
      return [{ name, version }]
    }))

  const violations = Array.flatMap(effectPins, ({ name, version }) =>
    exactVersionPattern.test(version)
      ? []
      : [`${name} must be an exact version; found ${quoted(version)}`])

  const distinctVersions = new Set(Array.map(effectPins, ({ version }) => version))
  if (violations.length === 0 && distinctVersions.size > 1) {
    violations.push(
      `effect packages must share one version; found ${Array.join([...distinctVersions], ", ")}`,
    )
  }

  if (effectPins.length === 0) {
    violations.push("expected at least one effect dependency to verify")
  }

  if (manifest.overrides?.effect === undefined) {
    violations.push("overrides must pin effect so transitive dependents share one copy")
  }

  const lockedVersions = new Set(
    Array.flatMap([...lockfile.matchAll(lockedEffectPattern)], ([, version]) => version === undefined ? [] : [version]),
  )
  if (lockedVersions.size !== 1) {
    violations.push(
      `bun.lock must resolve exactly one effect; found ${
        lockedVersions.size === 0 ? "none" : Array.join([...lockedVersions], ", ")
      }`,
    )
  }

  if (violations.length > 0) {
    yield* Console.error("Effect dependency pin check failed:")
    yield* Effect.forEach(violations, (violation) => Console.error(`- ${violation}`))
    process.exitCode = 1
    return
  }
  yield* Console.log(`Effect dependency pins are exact (${[...distinctVersions][0]}).`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
