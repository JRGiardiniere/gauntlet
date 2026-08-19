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
  "language-pitfalls",
  "presentation-environment",
  "refactoring-checklist",
  "removed-behavior",
  "spec-conformance",
  "subjective",
  "wrapper-proxy",
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
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
        scriptedLayer(makeScripted({ sessions: [] })),
        unusedGitHubLayer,
        unusedLinearLayer,
      ),
    ),
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
        "default-lenses": INITIAL_DEFAULT_LENSES,
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
        "default-lenses": [],
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

      expect(yield* config(fixture, "init")).toBe(1)
      expect(yield* stderr()).toContain(
        "duplicate shipped/project lens name: subjective",
      )
      expect(yield* fs.exists(fixture.settingsFile)).toBe(false)
      expect(yield* fs.exists(fixture.recipesDirectory)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects the retired deep-finders recipe key, not silently accepting it", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.makeDirectory(fixture.recipesDirectory, { recursive: true })
      yield* fs.writeFileString(
        path.join(fixture.recipesDirectory, "retired.json"),
        // @effect-diagnostics-next-line preferSchemaOverJson:off
        JSON.stringify({
          default: "fixture/model:low",
          "deep-finders": "fixture/strong-model:high",
        }),
      )
      expect(yield* config(fixture)).toBe(0)
      expect(yield* stdout()).toContain(
        "- retired — invalid (" + path.join(fixture.recipesDirectory, "retired.json"),
      )
      // Recipe decoding rejects unknown keys, so a rejected override fails
      // instead of silently inheriting the default seat.
      expect(yield* stdout()).toContain("deep-finders")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("lists, replaces, empties, and refuses to unset Default Lenses", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      expect(yield* config(fixture, "init")).toBe(0)

      expect(
        yield* config(
          fixture,
          "set",
          "default-lenses",
          "subjective",
          "fixture-review",
          "subjective",
        ),
      ).toBe(0)
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([
        "subjective",
        "fixture-review",
      ])

      expect(yield* config(fixture)).toBe(0)
      expect(yield* stdout()).toContain("- fixture-review (default Lens)")
      expect(yield* stdout()).toContain("- subjective (default Lens)")

      expect(yield* config(fixture, "set", "default-lenses")).toBe(0)
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([])
      expect(yield* config(fixture, "unset", "default-lenses")).toBe(1)
      expect(yield* stderr()).toContain("default-lenses cannot be unset")

      expect(
        yield* config(fixture, "set", "default-lenses", "missing-lens"),
      ).toBe(1)
      expect(yield* stderr()).toContain(
        "selected lens does not exist: missing-lens",
      )
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([])

      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(
        `${fixture.content}/lenses/invalid.md`,
        "---\nrouting: bugs\n---\ninvalid prompt\n",
      )
      expect(yield* config(fixture)).toBe(1)
      expect(yield* stderr()).toContain("could not configure")
      expect(yield* stderr()).toContain("not admitted: routing")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("uses the Git repository root for project-local Lens discovery", () =>
    Effect.gen(function* () {
      const fixture = yield* makeFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      expect(yield* config(fixture, "init")).toBe(0)
      yield* runGit(fixture.home, ["init"])

      const projectLenses = path.join(fixture.home, ".gauntlet", "lenses")
      const nested = path.join(fixture.home, "packages", "app")
      yield* fs.makeDirectory(projectLenses, { recursive: true })
      yield* fs.makeDirectory(nested, { recursive: true })
      yield* fs.writeFileString(
        path.join(projectLenses, "project-local.md"),
        "project-local prompt\n",
      )

      expect(yield* configAt(fixture, nested)).toBe(0)
      expect(yield* stdout()).toContain("project Lens catalog:")
      expect(yield* stdout()).toContain("- project-local")
      expect(
        yield* configAt(
          fixture,
          nested,
          "set",
          "default-lenses",
          "project-local",
        ),
      ).toBe(0)
      expect((yield* readSettings(fixture))["default-lenses"]).toEqual([
        "project-local",
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
