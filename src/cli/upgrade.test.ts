import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { Recipe } from "../domain/recipe.ts"
import { HostError, type HostModel, hostLayer, untouchedHostLayer } from "../host/host.ts"
import { upgradeSeats } from "./upgrade.ts"

// The seat step of `gauntlet upgrade` against a Host fake: the binary step
// needs a release binary and is outside this suite.

const variants = ["low", "medium", "high"]

const models: ReadonlyArray<HostModel> = [
  { providerID: "openai", id: "gpt-6-luna", variants },
  { providerID: "openai", id: "gpt-6.1-terra", variants },
  { providerID: "openai", id: "gpt-6.1-terra-fast", variants },
  // Newer, but the Host offers no fast model for it.
  { providerID: "openai", id: "gpt-6.2-terra", variants },
  { providerID: "openai", id: "gpt-6.2-sol", variants },
  { providerID: "openai", id: "gpt-7-sol", variants: ["low"] },
  { providerID: "claude-agent", id: "opus", variants },
]

const hostListing = (listModels: Effect.Effect<ReadonlyArray<HostModel>, HostError>) => {
  const untouched = Effect.die("unused")

  return hostLayer({
    openSession: () => untouched,
    listModels,
    connection: () => untouched,
    chatGptSignIn: { start: untouched, status: () => untouched, paste: () => untouched, cancel: () => untouched },
  })
}

const withRecipes = Effect.fn("test.withRecipes")(function* (recipes: Record<string, string>) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-upgrade-" })
  const directory = path.join(home, ".gauntlet", "recipes")
  yield* fs.makeDirectory(directory, { recursive: true })

  for (const [name, text] of Record.toEntries(recipes)) {
    yield* fs.writeFileString(path.join(directory, `${name}.json`), text)
  }

  return { home, directory }
})

const lines = (values: ReadonlyArray<unknown>) => Array.join(Array.map(values, String), "\n")

describe("upgradeSeats", () => {
  it.effect("moves seats only to models and efforts the Host accepts", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const { home, directory } = yield* withRecipes({
        quick: '{"default":"openai/gpt-6.1-terra:high+fast"}\n',
        medium: '{"default":"openai/gpt-6.1-sol:medium","finders":"openai/gpt-5.6-luna:high"}\n',
        "claude-high": '{"default":"claude-code/opus:high"}\n',
      })

      yield* upgradeSeats().pipe(
        Effect.provide([hostListing(Effect.succeed(models)), ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))]),
      )
      const read = (name: string) => fs.readFileString(path.join(directory, `${name}.json`))
      const quick = yield* read("quick")
      expect(quick).toBe('{"default":"openai/gpt-6.1-terra:high+fast"}\n')
      const medium = yield* read("medium").pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Recipe))))
      expect(medium).toEqual({
        default: "openai/gpt-6.2-sol:medium",
        finders: "openai/gpt-6-luna:high",
      })
      const claudeHigh = yield* read("claude-high")
      expect(claudeHigh).toBe('{"default":"claude-code/opus:high"}\n')
      const logLines = yield* TestConsole.logLines
      expect(lines(logLines)).toContain("recipes medium → openai/gpt-6.2-sol (was openai/gpt-6.1-sol)")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reports an unavailable model list without failing or touching recipes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const original = '{"default":"openai/gpt-6.1-sol:medium"}\n'
      const { home, directory } = yield* withRecipes({ medium: original })
      const offline = Effect.fail(HostError.make({ operation: "list models", reason: "offline" }))
      yield* upgradeSeats().pipe(
        Effect.provide([
          hostListing(offline),
          ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home })),
        ]),
      )
      const medium = yield* fs.readFileString(path.join(directory, "medium.json"))
      expect(medium).toBe(original)
      const errorLines = yield* TestConsole.errorLines
      expect(lines(errorLines)).toContain("could not upgrade recipe seats — the model list is unavailable: offline")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("never boots the Host when there is no valid recipe to upgrade", () =>
    Effect.gen(function* () {
      const { home } = yield* withRecipes({ broken: '{"default":"openai/gpt-6.1-sol:medium","typo":1}\n' })
      yield* upgradeSeats().pipe(
        Effect.provide([untouchedHostLayer, ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))]),
      )
      const logLines = yield* TestConsole.logLines
      expect(lines(logLines)).toContain("skipped invalid recipes broken")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("says OpenAI seats went unchecked when the Host lists no OpenAI models", () =>
    Effect.gen(function* () {
      const { home } = yield* withRecipes({ medium: '{"default":"openai/gpt-6.1-sol:medium"}\n' })
      const claudeOnly = Array.filter(models, (model) => model.providerID !== "openai")
      yield* upgradeSeats().pipe(
        Effect.provide([hostListing(Effect.succeed(claudeOnly)), ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))]),
      )
      const logLines = yield* TestConsole.logLines
      expect(lines(logLines)).toContain("OpenAI seats were not checked")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("says nothing about OpenAI when no Recipe has an OpenAI Seat", () =>
    Effect.gen(function* () {
      const { home } = yield* withRecipes({ "claude-high": '{"default":"claude-code/opus:high"}\n' })
      const claudeOnly = Array.filter(models, (model) => model.providerID !== "openai")
      yield* upgradeSeats().pipe(
        Effect.provide([hostListing(Effect.succeed(claudeOnly)), ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))]),
      )
      const logLines = yield* TestConsole.logLines
      expect(lines(logLines)).not.toContain("OpenAI")
      expect(lines(logLines)).toContain("recipe seats are current")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
