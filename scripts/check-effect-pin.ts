// The Effect-pin gate's runMain boundary. The effect family must be pinned to
// one exact version, but which version is the manifest's business — update
// with `bun add --exact effect@rc` (plus the sibling @effect packages), and
// this check re-verifies the result. `rc` is the v4 dist-tag until v4 reaches
// `latest`.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"

const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
] as const
const independentlyVersionedEffectPackages = new Set(["@effect/tsgo"])
const exactVersionPattern = /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/

const DependencyMap = Schema.Record(Schema.String, Schema.String)
const Manifest = Schema.fromJsonString(Schema.Struct({
  dependencies: Schema.optional(DependencyMap),
  devDependencies: Schema.optional(DependencyMap),
  peerDependencies: Schema.optional(DependencyMap),
  optionalDependencies: Schema.optional(DependencyMap),
}))

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const source = yield* fs.readFileString(`${import.meta.dirname}/../package.json`)
  const manifest = yield* Schema.decodeEffect(Manifest)(source)

  const effectPins = dependencyFields.flatMap((field) =>
    Object.entries(manifest[field] ?? {}).flatMap(([name, version]) => {
      if (name !== "effect" && !name.startsWith("@effect/")) return []
      if (independentlyVersionedEffectPackages.has(name)) return []
      return [{ name, version }]
    }))

  const violations = effectPins.flatMap(({ name, version }) =>
    exactVersionPattern.test(version)
      ? []
      : [`${name} must be an exact version; found ${JSON.stringify(version)}`])

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
    yield* Console.error("Effect dependency pin check failed:")
    yield* Effect.forEach(violations, (violation) => Console.error(`- ${violation}`))
    process.exitCode = 1
    return
  }
  yield* Console.log(`Effect dependency pins are exact (${[...distinctVersions][0]}).`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
