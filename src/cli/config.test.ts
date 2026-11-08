import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { Settings } from "../config/settings.ts"
import { ContentDirectory } from "../content/lens.ts"
import { Recipe } from "../domain/recipe.ts"
import { unusedGitHubLayer } from "../github/github.ts"
import { unusedLinearLayer } from "../linear/linear.ts"
import { makeScripted, scriptedLayer } from "../harness/scripted.ts"
import { runGit } from "../target/git.ts"
import { runGauntlet } from "./main.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"

interface Fixture {
  readonly home: string
  readonly content: string
  readonly recipesDirectory: string
  readonly settingsFile: string
}

const INITIAL_DEFAULT_LENSES = [
  "absence",
  "cleanup",
  "cross-file",
  "diff-scan",
  "presentation-environment",
  "removed-behavior",
  "spec-conformance",
  "standards",
  "subjective",
] as const

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped({
    prefix: "gauntlet-config-test-",
  })
  const content = path.join(home, "content")
  yield* fs.makeDirectory(path.join(content, "lenses"), { recursive: true })
  yield* Effect.forEach(
    [...INITIAL_DEFAULT_LENSES, "fixture-review"],
    (name) =>
      fs.writeFileString(
        path.join(content, "lenses", `${name}.md`),
        `${name} tail\n`,
      ),
    { discard: true },
  )
  return {
    home,
    content,
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

const configAt = (
  fixture: Fixture,
  invocationDirectory: string,
  ...argv: Array<string>
) =>
  runGauntlet(["config", ...argv]).pipe(
    Effect.provideService(InvocationDirectory, invocationDirectory),
    Effect.provideService(ContentDirectory, fixture.content),
    Effect.provide([
      NodeServices.layer,
      ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
      scriptedLayer(makeScripted({ sessions: [] })),
      unusedGitHubLayer,
      unusedLinearLayer,
    ]),
  )

const config = (fixture: Fixture, ...argv: Array<string>) =>
  configAt(fixture, fixture.home, ...argv)

const readSettings = (fixture: Fixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    return yield* fs.readFileString(fixture.settingsFile).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Settings))),
    )
  })

const stdout = () =>
  Effect.map(TestConsole.logLines, (lines) => Array.join(Array.map(lines, String), "\n"))
const stderr = () =>
  Effect.map(TestConsole.errorLines, (lines) => Array.join(Array.map(lines, String), "\n"))

describe("gauntlet config init", () => {
  it.effect("seeds a fresh catalog and settings, then no-ops while valid", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const initExit = yield* config(fixture, "init")
      expect(initExit).toBe(0)

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
      const quickRecipe = yield* readRecipe("quick")
      expect(quickRecipe).toEqual({
        default: "openai/gpt-6-luna:high",
        finders: "openai/gpt-6-sol:low",
      })
      const lowRecipe = yield* readRecipe("low")
      expect(lowRecipe).toEqual({
        default: "openai/gpt-6-luna:high",
      })
      const mediumRecipe = yield* readRecipe("medium")
      expect(mediumRecipe).toEqual({
        default: "openai/gpt-6.1-sol:medium",
      })
      const highRecipe = yield* readRecipe("high")
      expect(highRecipe).toEqual({
        default: "openai/gpt-6.1-sol:high",
      })
      const settings = yield* readSettings(fixture)
      expect(settings).toEqual({
        "default-recipe": "medium",
        "default-lenses": INITIAL_DEFAULT_LENSES,
        favorites: ["quick", "low", "medium", "high"],
      })
      const initOutput = yield* stdout()
      expect(initOutput).toContain("initialized")

      // A valid second invocation changes nothing.
      const settingsBefore = yield* fs.readFileString(fixture.settingsFile)
      const secondInitExit = yield* config(fixture, "init")
      expect(secondInitExit).toBe(0)
      const secondInitOutput = yield* stdout()
      expect(secondInitOutput).toContain("already initialized")
      const settingsAfter = yield* fs.readFileString(fixture.settingsFile)
      expect(settingsAfter).toBe(settingsBefore)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a partial configuration with repair guidance, never healing it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const initExit = yield* config(fixture, "init")
      expect(initExit).toBe(0)

      const fs = yield* FileSystem.FileSystem

      // Catalog present, settings missing.
      yield* fs.remove(fixture.settingsFile)
      const missingSettingsExit = yield* config(fixture, "init")
      expect(missingSettingsExit).toBe(1)
      const missingSettingsError = yield* stderr()
      expect(missingSettingsError).toContain("settings.json is missing")
      const settingsExists = yield* fs.exists(fixture.settingsFile)
      expect(settingsExists).toBe(false)

      // Settings present, default recipe dangling.
      yield* writeSettings(fixture, {
        "default-recipe": "gone",
        "default-lenses": [],
        favorites: [],
      })
      const danglingRecipeExit = yield* config(fixture, "init")
      expect(danglingRecipeExit).toBe(1)
      const danglingRecipeError = yield* stderr()
      expect(danglingRecipeError).toContain(
        "default-recipe gone does not name an available valid recipe",
      )

      // Settings malformed.
      yield* fs.writeFileString(fixture.settingsFile, "{not json\n")
      const malformedExit = yield* config(fixture, "init")
      expect(malformedExit).toBe(1)
      const malformedError = yield* stderr()
      expect(malformedError).toContain("fix settings.json, then rerun init")
      const malformedSettings = yield* fs.readFileString(fixture.settingsFile)
      expect(malformedSettings).toBe("{not json\n")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("validates fresh Default Lenses before writing configuration", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const projectLenses = path.join(fixture.home, ".gauntlet", "lenses")
      yield* fs.makeDirectory(projectLenses, { recursive: true })
      yield* fs.writeFileString(
        path.join(projectLenses, "subjective.md"),
        "duplicate project Lens\n",
      )

      const initExit = yield* config(fixture, "init")
      expect(initExit).toBe(1)
      const initError = yield* stderr()
      expect(initError).toContain("duplicate shipped/project lens name: subjective")
      const settingsExists = yield* fs.exists(fixture.settingsFile)
      expect(settingsExists).toBe(false)
      const recipesExist = yield* fs.exists(fixture.recipesDirectory)
      expect(recipesExist).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("lists, replaces, empties, and refuses to unset Default Lenses", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const initExit = yield* config(fixture, "init")
      expect(initExit).toBe(0)

      const setExit = yield* config(
        fixture,
        "set",
        "default-lenses",
        "subjective",
        "fixture-review",
        "subjective",
      )
      expect(setExit).toBe(0)
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([
        "subjective",
        "fixture-review",
      ])

      const listExit = yield* config(fixture)
      expect(listExit).toBe(0)
      const listing = yield* stdout()
      expect(listing).toContain("- fixture-review (default Lens)")
      expect(listing).toContain("- subjective (default Lens)")

      const emptySetExit = yield* config(fixture, "set", "default-lenses")
      expect(emptySetExit).toBe(0)
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([])
      const unsetExit = yield* config(fixture, "unset", "default-lenses")
      expect(unsetExit).toBe(1)
      const unsetError = yield* stderr()
      expect(unsetError).toContain("default-lenses cannot be unset")

      const missingLensExit = yield* config(fixture, "set", "default-lenses", "missing-lens")
      expect(missingLensExit).toBe(1)
      const missingLensError = yield* stderr()
      expect(missingLensError).toContain("selected lens does not exist: missing-lens")
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([])

      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(
        `${fixture.content}/lenses/invalid.md`,
        "---\nrouting: bugs\n---\ninvalid prompt\n",
      )
      const invalidLensExit = yield* config(fixture)
      expect(invalidLensExit).toBe(1)
      const invalidLensError = yield* stderr()
      expect(invalidLensError).toContain("could not configure")
      expect(invalidLensError).toContain("not admitted: routing")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("renders a failed settings write as a configuration failure naming its cause", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const initExit = yield* config(fixture, "init")
      expect(initExit).toBe(0)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = path.dirname(fixture.settingsFile)

      yield* fs.chmod(directory, 0o555)
      const exitCode = yield* config(fixture, "set", "favorites", "quick").pipe(
        Effect.ensuring(fs.chmod(directory, 0o755).pipe(Effect.orDie)),
      )

      expect(exitCode).toBe(1)
      const rendered = yield* stderr()
      expect(rendered).toContain(
        `could not configure — failed to write ${fixture.settingsFile}: FileSystem.`,
      )
      expect(rendered).toContain(": PermissionDenied (EACCES)")
      expect(rendered).not.toContain("could not review")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("uses the Git repository root for project-local Lens discovery", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const initExit = yield* config(fixture, "init")
      expect(initExit).toBe(0)
      yield* runGit(fixture.home, ["init"])

      const projectLenses = path.join(fixture.home, ".gauntlet", "lenses")
      const nested = path.join(fixture.home, "packages", "app")
      yield* fs.makeDirectory(projectLenses, { recursive: true })
      yield* fs.makeDirectory(nested, { recursive: true })
      yield* fs.writeFileString(
        path.join(projectLenses, "project-local.md"),
        "project-local prompt\n",
      )

      const nestedListExit = yield* configAt(fixture, nested)
      expect(nestedListExit).toBe(0)
      const nestedListing = yield* stdout()
      expect(nestedListing).toContain("project Lens catalog:")
      expect(nestedListing).toContain("- project-local")
      const nestedSetExit = yield* configAt(
        fixture,
        nested,
        "set",
        "default-lenses",
        "project-local",
      )
      expect(nestedSetExit).toBe(0)
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([
        "project-local",
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
