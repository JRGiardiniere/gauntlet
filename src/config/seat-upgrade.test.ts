import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { Recipe } from "../domain/recipe.ts"
import { newerSeat, renderSeatUpgrade, upgradeRecipeSeats } from "./seat-upgrade.ts"

const catalog = new Map<string, ReadonlyArray<string>>([
  ["acme", [
    "gpt-5.6-luna",
    "gpt-6-luna",
    "gpt-6-luna-mini",
    "gpt-6-luna:batch",
    "gpt-10-sol",
    "gpt-6-sol",
    "gpt-7-astra",
  ]],
  ["lagging", ["gpt-5.6-luna"]],
])
const providerModelIds = (provider: string) => catalog.get(provider) ?? []
const decodeRecipe = Schema.decodeUnknownEffect(Schema.fromJsonString(Recipe))

describe("newerSeat", () => {
  it.each([
    ["acme/gpt-5.6-luna:high", "acme/gpt-6-luna:high"],
    ["acme/gpt-6-sol:low", "acme/gpt-10-sol:low"],
    ["acme/gpt-6-luna:medium", undefined],
    ["lagging/gpt-5.6-luna:high", undefined],
    ["acme/gpt-6-astra:high", undefined],
    ["acme/glm-5.3-flash:high", undefined],
  ])("%s → %s", (seat, expected) => {
    expect(Option.getOrUndefined(newerSeat(seat, providerModelIds))).toBe(expected)
  })
})

describe("upgradeRecipeSeats", () => {
  it.effect("rewrites only outdated seats in place and reports each move", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-seat-upgrade-" })
      const recipes = path.join(home, ".gauntlet", "recipes")
      yield* fs.makeDirectory(recipes, { recursive: true })
      const untouched = '{"default":"lagging/gpt-5.6-luna:high"}\n'
      yield* fs.writeFileString(
        path.join(recipes, "quick.json"),
        '{"default":"acme/gpt-5.6-luna:high","finders":"acme/gpt-6-sol:low"}\n',
      )
      yield* fs.writeFileString(path.join(recipes, "fast.json"), '{"default":"acme/gpt-5.6-luna:low"}\n')
      yield* fs.writeFileString(path.join(recipes, "slow.json"), untouched)
      const invalid = '{"default":"acme/gpt-5.6-luna:high","typo":true}\n'
      yield* fs.writeFileString(path.join(recipes, "broken.json"), invalid)

      const upgrade = yield* upgradeRecipeSeats(providerModelIds).pipe(
        Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
      )

      expect(yield* decodeRecipe(yield* fs.readFileString(path.join(recipes, "quick.json")))).toEqual({
        default: "acme/gpt-6-luna:high",
        finders: "acme/gpt-10-sol:low",
      })
      expect(yield* decodeRecipe(yield* fs.readFileString(path.join(recipes, "fast.json")))).toEqual({
        default: "acme/gpt-6-luna:low",
      })
      expect(yield* fs.readFileString(path.join(recipes, "slow.json"))).toBe(untouched)
      expect(yield* fs.readFileString(path.join(recipes, "broken.json"))).toBe(invalid)
      expect(renderSeatUpgrade(upgrade)).toEqual([
        "recipes fast, quick → acme/gpt-6-luna (was acme/gpt-5.6-luna)",
        "recipes quick → acme/gpt-10-sol (was acme/gpt-6-sol)",
        "skipped invalid recipes broken — run `gauntlet config`",
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
