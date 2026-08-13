import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { Settings } from "../config/settings.ts"
import { Recipe } from "../domain/recipe.ts"
import { unusedGitHubLayer } from "../github/github.ts"
import { makeScripted, scriptedLayer } from "../harness/scripted.ts"
import { runGauntlet } from "./main.ts"

interface Fixture {
  readonly home: string
  readonly recipesDirectory: string
  readonly settingsFile: string
}

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped({
    prefix: "gauntlet-config-test-",
  })
  return {
    home,
    recipesDirectory: path.join(home, ".gauntlet", "recipes"),
    settingsFile: path.join(home, ".gauntlet", "settings.json"),
  }
})

const encodeSettings = Schema.encodeEffect(Schema.fromJsonString(Settings))

const writeSettings = (fixture: Fixture, settings: Settings) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const json = yield* encodeSettings(settings)
    yield* fs.writeFileString(fixture.settingsFile, `${json}\n`)
  })

const config = (fixture: Fixture, ...argv: Array<string>) =>
  runGauntlet(["config", ...argv]).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
        scriptedLayer(makeScripted({ sessions: [] })),
        unusedGitHubLayer,
      ),
    ),
  )

const readSettings = (fixture: Fixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(fixture.settingsFile).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))),
    )
  })

const stdout = () =>
  Effect.map(TestConsole.logLines, (lines) => lines.join("\n"))
const stderr = () =>
  Effect.map(TestConsole.errorLines, (lines) => lines.join("\n"))

describe("gauntlet config init", () => {
  it.effect("seeds a fresh catalog and settings, then no-ops while valid", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      expect(yield* config(fixture, "init")).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const entries = yield* fs.readDirectory(fixture.recipesDirectory)
      expect(entries.sort()).toEqual([
        "high.json",
        "low.json",
        "medium.json",
        "quick.json",
      ])
      const readRecipe = (name: string) =>
        fs.readFileString(
          path.join(fixture.recipesDirectory, `${name}.json`),
        ).pipe(
          Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Recipe))),
        )
      expect(yield* readRecipe("quick")).toEqual({
        default: "openai-codex/gpt-5.6-luna:high",
        finders: "openai-codex/gpt-5.6-sol:low",
      })
      expect(yield* readRecipe("low")).toEqual({
        default: "openai-codex/gpt-5.6-luna:high",
      })
      expect(yield* readRecipe("medium")).toEqual({
        default: "openai-codex/gpt-5.6-sol:medium",
      })
      expect(yield* readRecipe("high")).toEqual({
        default: "openai-codex/gpt-5.6-sol:high",
      })
      expect(yield* readSettings(fixture)).toEqual({
        "default-recipe": "medium",
        favorites: ["quick", "low", "medium", "high"],
      })
      expect(yield* stdout()).toContain("initialized")

      // A valid second invocation changes nothing.
      const settingsBefore = yield* fs.readFileString(fixture.settingsFile)
      expect(yield* config(fixture, "init")).toBe(0)
      expect(yield* stdout()).toContain("already initialized")
      expect(yield* fs.readFileString(fixture.settingsFile)).toBe(
        settingsBefore,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a partial configuration with repair guidance, never healing it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      expect(yield* config(fixture, "init")).toBe(0)

      const fs = yield* FileSystem.FileSystem

      // Catalog present, settings missing.
      yield* fs.remove(fixture.settingsFile)
      expect(yield* config(fixture, "init")).toBe(1)
      expect(yield* stderr()).toContain("settings.json is missing")
      expect(yield* fs.exists(fixture.settingsFile)).toBe(false)

      // Settings present, default recipe dangling.
      yield* writeSettings(fixture, {
        "default-recipe": "gone",
        favorites: [],
      })
      expect(yield* config(fixture, "init")).toBe(1)
      expect(yield* stderr()).toContain(
        "default-recipe gone does not name an available valid recipe",
      )

      // Settings malformed.
      yield* fs.writeFileString(fixture.settingsFile, "{not json\n")
      expect(yield* config(fixture, "init")).toBe(1)
      expect(yield* stderr()).toContain("fix settings.json, then rerun init")
      expect(yield* fs.readFileString(fixture.settingsFile)).toBe("{not json\n")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

