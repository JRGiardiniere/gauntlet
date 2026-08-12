import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Settings } from "../config/settings.ts"
import { Recipe } from "../domain/recipe.ts"
import { makeScripted, scriptedLayer } from "../harness/scripted.ts"
import { runGauntlet } from "./main.ts"

interface Fixture {
  readonly home: string
  readonly recipesDirectory: string
  readonly settingsFile: string
}

const makeFixture = (): Fixture => {
  const home = mkdtempSync(join(tmpdir(), "gauntlet-config-test-"))
  return {
    home,
    recipesDirectory: join(home, ".gauntlet", "recipes"),
    settingsFile: join(home, ".gauntlet", "settings.json"),
  }
}

const writeRecipe = (fixture: Fixture, name: string, recipe: object) => {
  mkdirSync(fixture.recipesDirectory, { recursive: true })
  writeFileSync(
    join(fixture.recipesDirectory, `${name}.json`),
    `${JSON.stringify(recipe)}\n`,
  )
}

const config = (fixture: Fixture, ...argv: Array<string>) =>
  runGauntlet(["config", ...argv]).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
        scriptedLayer(makeScripted({ sessions: [] })),
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
      const fixture = makeFixture()
      expect(yield* config(fixture, "init")).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const entries = yield* fs.readDirectory(fixture.recipesDirectory)
      expect(entries.sort()).toEqual([
        "high.json",
        "low.json",
        "medium.json",
        "quick.json",
      ])
      const readRecipe = (name: string) =>
        fs.readFileString(join(fixture.recipesDirectory, `${name}.json`)).pipe(
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
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses a partial configuration with repair guidance, never healing it", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      expect(yield* config(fixture, "init")).toBe(0)

      // Catalog present, settings missing.
      rmSync(fixture.settingsFile)
      expect(yield* config(fixture, "init")).toBe(1)
      expect(yield* stderr()).toContain("settings.json is missing")
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(fixture.settingsFile)).toBe(false)

      // Settings present, default recipe dangling.
      writeFileSync(
        fixture.settingsFile,
        `${JSON.stringify({ "default-recipe": "gone", favorites: [] })}\n`,
      )
      expect(yield* config(fixture, "init")).toBe(1)
      expect(yield* stderr()).toContain(
        "default-recipe gone does not name an available valid recipe",
      )

      // Settings malformed.
      writeFileSync(fixture.settingsFile, "{not json\n")
      expect(yield* config(fixture, "init")).toBe(1)
      expect(yield* stderr()).toContain("fix or delete settings.json")
      expect(yield* fs.readFileString(fixture.settingsFile)).toBe("{not json\n")
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("gauntlet config", () => {
  it.effect("lists favorites in configured order, annotates the default, and keeps invalid recipes visible", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      expect(yield* config(fixture, "init")).toBe(0)
      writeRecipe(fixture, "fixture-extra", {
        default: "fixture/fixture-model:low",
        judgment: "fixture/fixture-model:high",
      })
      writeRecipe(fixture, "fixture-broken", {
        default: "fixture/fixture-model:low",
        budgets: { maxUsd: 5 },
      })
      writeRecipe(fixture, "Fixture_Bad_Name", {
        default: "fixture/fixture-model:low",
      })
      writeFileSync(
        fixture.settingsFile,
        `${
          JSON.stringify({
            "default-recipe": "medium",
            favorites: ["high", "quick", "fixture-ghost"],
          })
        }\n`,
      )

      expect(yield* config(fixture)).toBe(0)
      const output = yield* stdout()
      expect(output).toContain(`settings: ${fixture.settingsFile}`)
      expect(output).toContain(`recipe catalog: ${fixture.recipesDirectory}`)
      expect(output).toContain(
        `runs root: ${join(fixture.home, ".gauntlet", "runs")}`,
      )
      expect(output).toContain(
        "warning: favorites name missing recipes: fixture-ghost",
      )
      // Favorites keep their configured order; the rest are alphabetical.
      const favoriteHigh = output.indexOf("- high —")
      const favoriteQuick = output.indexOf("- quick —")
      expect(favoriteHigh).toBeGreaterThan(-1)
      expect(favoriteHigh).toBeLessThan(favoriteQuick)
      const remaining = output.slice(output.lastIndexOf("recipes:"))
      expect(remaining.indexOf("fixture-broken")).toBeLessThan(
        remaining.indexOf("fixture-extra"),
      )
      expect(remaining.indexOf("fixture-extra")).toBeLessThan(
        remaining.indexOf("- low —"),
      )
      expect(output).toContain("- medium (default recipe) —")
      expect(output).toContain("default openai-codex/gpt-5.6-sol:medium")
      expect(output).toContain(
        "fixture-extra — default fixture/fixture-model:low · judgment fixture/fixture-model:high",
      )
      expect(output).toContain("- fixture-broken — invalid (")
      expect(output).toContain("fixture-broken.json")
      expect(output).toContain(
        "- Fixture_Bad_Name — invalid",
      )
      expect(output).toContain("not lowercase-kebab-case")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("explains an uninitialized or malformed configuration instead of failing", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      expect(yield* config(fixture)).toBe(0)
      expect(yield* stdout()).toContain("missing — run `gauntlet config init`")

      writeRecipe(fixture, "fixture-extra", {
        default: "fixture/fixture-model:low",
      })
      writeFileSync(
        fixture.settingsFile,
        `${JSON.stringify({ "default-recipe": "medium" })}\n`,
      )
      expect(yield* config(fixture)).toBe(0)
      const output = yield* stdout()
      expect(output).toContain("settings are invalid")
      expect(output).toContain("- fixture-extra —")
    }).pipe(Effect.provide(NodeServices.layer)))
})

describe("gauntlet config set/unset", () => {
  it.effect("mutates default-recipe and favorites with availability validation", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      expect(yield* config(fixture, "init")).toBe(0)

      expect(yield* config(fixture, "set", "default-recipe", "high")).toBe(0)
      expect((yield* readSettings(fixture))["default-recipe"]).toBe("high")

      expect(yield* config(fixture, "set", "default-recipe", "missing")).toBe(1)
      expect(yield* stderr()).toContain("recipe does not exist: missing")
      expect((yield* readSettings(fixture))["default-recipe"]).toBe("high")

      expect(yield* config(fixture, "unset", "default-recipe")).toBe(1)
      expect(yield* stderr()).toContain("default-recipe cannot be unset")

      expect(yield* config(fixture, "set", "favorites", "low", "high")).toBe(0)
      expect((yield* readSettings(fixture)).favorites).toEqual(["low", "high"])

      expect(yield* config(fixture, "set", "favorites", "low", "low")).toBe(1)
      expect(yield* stderr()).toContain("favorites must be distinct")

      expect(yield* config(fixture, "set", "favorites", "low", "missing")).toBe(1)
      expect((yield* readSettings(fixture)).favorites).toEqual(["low", "high"])

      expect(yield* config(fixture, "unset", "favorites")).toBe(0)
      expect((yield* readSettings(fixture)).favorites).toEqual([])

      expect(yield* config(fixture, "set", "fixture-key", "value")).toBe(1)
      expect(yield* stderr()).toContain("unknown settings key")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("normalizes runs-root, rejects relative paths, and requires initialized settings", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()

      // set/unset never bootstrap settings; init is the sole creator.
      expect(yield* config(fixture, "set", "default-recipe", "medium")).toBe(1)
      expect(yield* stderr()).toContain("run `gauntlet config init` first")

      expect(yield* config(fixture, "init")).toBe(0)

      expect(yield* config(fixture, "set", "runs-root", "~/fixture-runs")).toBe(0)
      expect((yield* readSettings(fixture))["runs-root"]).toBe(
        join(fixture.home, "fixture-runs"),
      )

      expect(yield* config(fixture, "set", "runs-root", "relative/runs")).toBe(1)
      expect(yield* stderr()).toContain("absolute or ~/ path")

      expect(yield* config(fixture, "unset", "runs-root")).toBe(0)
      const settings = yield* readSettings(fixture)
      expect("runs-root" in settings).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))
})
