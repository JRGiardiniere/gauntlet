import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { isFreshConfig, writeInitialConfig } from "./initial-config.ts"
import { listRecipes } from "./recipe-catalog.ts"
import { ConfigHost, loadSettings } from "./settings.ts"

// The Mod's own configuration under ~/.gauntlet/mod (#177), read the way the
// Mod reads it.
const asMod = <A, E, R>(home: string, effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(ConfigHost, "mod"),
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
  )

describe("the Mod's configuration", () => {
  it.effect("is written once into a fresh home, and a partial one is left alone", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-mod-config-" })
      expect(yield* asMod(home, isFreshConfig())).toBe(true)
      yield* asMod(home, writeInitialConfig())

      const entries = yield* asMod(home, listRecipes())
      expect(entries.map((entry) => [entry.name, entry._tag])).toEqual([
        ["high", "ValidRecipe"],
        ["low", "ValidRecipe"],
        ["medium", "ValidRecipe"],
      ])
      const settings = yield* asMod(home, loadSettings())
      expect(Option.map(settings, (value) => value["default-recipe"])).toEqual(Option.some("medium"))
      expect(yield* fs.exists(path.join(home, ".gauntlet", "settings.json"))).toBe(false)

      yield* fs.remove(path.join(home, ".gauntlet", "mod", "settings.json"))
      expect(yield* asMod(home, isFreshConfig())).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("lists a recipe seating another provider as invalid, naming the Seat it takes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-mod-config-" })
      const recipes = path.join(home, ".gauntlet", "mod", "recipes")
      yield* fs.makeDirectory(recipes, { recursive: true })
      yield* fs.writeFileString(path.join(recipes, "fixture.json"), `{"default":"fixture/fixture-model:low"}\n`)

      const [entry] = yield* asMod(home, listRecipes())
      expect(entry?._tag).toBe("InvalidRecipe")
      if (entry?._tag !== "InvalidRecipe") return
      expect(entry.error).toContain("the Mod runs only claude-code/<model>:<effort> Seats")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
