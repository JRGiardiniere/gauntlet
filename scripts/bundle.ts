// The bundle step's runMain boundary. Compile the single-file distribution:
// bin/gauntlet.ts plus the shipped content catalog embedded as Bun assets.
// `compile.assets` embeds the content/ tree wholesale; stage-owned markdown
// scattered under src/ still needs per-file `with { type: "file" }` imports
// (assets take literal directories — no globs or extension filtering, so it
// cannot target src/).
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Config from "effect/Config"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { pipe } from "effect/Function"
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import { compileBinary } from "./compile.ts"

process.chdir(`${import.meta.dirname}/..`)

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem

  // Release builds (the tag workflow) set all three; a bare `bun run bundle`
  // produces a host-platform dev binary reporting the 0.0.0-dev sentinel.
  const versionSetting = yield* Config.option(Config.String("GAUNTLET_VERSION"))
  const version = Option.getOrElse(versionSetting, () => "0.0.0-dev")
  const targetSetting = yield* Config.option(Config.String("GAUNTLET_TARGET"))
  const target = Option.getOrUndefined(targetSetting)
  const outfileSetting = yield* Config.option(Config.String("GAUNTLET_OUTFILE"))
  const outfile = Option.getOrElse(outfileSetting, () => "dist/gauntlet")

  // Defines take JS expression source: the version string becomes a quoted
  // string literal via the JSON codec. Every compiled binary carries the
  // define — src/cli/version.ts references the identifier whenever
  // isCompiledBinary holds.
  const define = {
    GAUNTLET_VERSION: yield* Schema.encodeEffect(Schema.fromJsonString(Schema.String))(version),
  }

  // Stage-owned prompt templates (markdown living with its Stage module,
  // e.g. src/stages/judgment/judge.md).
  const sourceEntries = yield* fs.readDirectory("src", { recursive: true })
  const stageTemplateImports = pipe(
    sourceEntries,
    Array.filter((entry) => entry.endsWith(".md")),
    Array.map((entry) => `src/${entry}`),
  )

  const entrySource = Array.join([
    ...Array.map(stageTemplateImports, (file, index) =>
      `import asset${String(index)} from "./${file}" with { type: "file" }`),
    `export const embeddedStageTemplates = [${pipe(stageTemplateImports, Array.map((_, index) => `asset${String(index)}`), Array.join(", "))}]`,
    `import "./bin/gauntlet.ts"`,
    "",
  ], "\n")

  yield* fs.makeDirectory("dist", { recursive: true })
  yield* compileBinary({ entrySource, outfile, target, define })
  yield* Console.log(`compiled ${outfile}`)
})

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
