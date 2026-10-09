import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ClaudeRecipe, PiRecipe, Recipe, type RecipeName } from "../domain/recipe.ts"
import type { LensName } from "../domain/review-plan.ts"
import { writeArtifactJson } from "../run/artifact.ts"
import { listRecipes } from "./recipe-catalog.ts"
import { ConfigHost, type Host, recipesDirectory, settingsPath, writeSettings } from "./settings.ts"

// What a Host's fresh configuration holds: `config init` writes it, and the
// Mod writes its own the first time it loads (#177). After that the files
// are user-owned; nothing re-reads or replenishes them, and only
// `gauntlet upgrade` touches the CLI's, moving Luna/Sol seats forward (#121).
export interface InitialConfig {
  readonly recipes: ReadonlyArray<readonly [RecipeName, Recipe]>
  readonly defaultRecipe: RecipeName
}

export const INITIAL_CONFIG: Readonly<Record<Host, InitialConfig>> = {
  // The CLI's mirror the old reviewer's MODEL_TIERS: quick keeps the manual
  // luna:high downstream tune under sol:low finders; low/medium/high run one
  // seat top to bottom (John's 2026-08-10 uniform-preset call).
  cli: {
    recipes: [
      [
        "quick",
        PiRecipe.make({
          default: "openai/gpt-6-luna:high",
          finders: "openai/gpt-6-sol:low",
        }),
      ],
      ["low", PiRecipe.make({ default: "openai/gpt-6-luna:high" })],
      ["medium", PiRecipe.make({ default: "openai/gpt-6.1-sol:medium" })],
      ["high", PiRecipe.make({ default: "openai/gpt-6.1-sol:high" })],
    ],
    defaultRecipe: "medium",
  },
  mod: {
    recipes: [
      ["low", ClaudeRecipe.make({ default: "claude-code/sonnet:medium" })],
      ["medium", ClaudeRecipe.make({ default: "claude-code/opus:medium" })],
      ["high", ClaudeRecipe.make({ default: "claude-code/opus:high" })],
    ],
    defaultRecipe: "medium",
  },
}

// language-pitfalls, refactoring-checklist, security and wrapper-proxy stay in
// the catalog but are not seeded: across 192 runs they and cross-file found 32
// of 396 unique P1/P2 findings for a third of Finder spend. cross-file is
// seeded anyway, because seeded bugs never span files and a real PR's
// regression reached a SQL join only a cross-file trace followed.
export const INITIAL_DEFAULT_LENSES: ReadonlyArray<LensName> = [
  "absence",
  "cleanup",
  "cross-file",
  "diff-scan",
  "presentation-environment",
  "removed-behavior",
  "spec-conformance",
  "standards",
  "subjective",
]

// Fresh is no settings file and an empty catalog; anything between fresh and
// valid is partial, and nothing heals it (issue #24).
export const isFreshConfig = Effect.fn("InitialConfig.isFresh")(function* () {
  const fs = yield* FileSystem.FileSystem
  const settingsExists = yield* fs.exists(yield* settingsPath())
  return !settingsExists && (yield* listRecipes()).length === 0
})

// Writes the Host's initial recipes and settings; callers check freshness
// first.
export const writeInitialConfig = Effect.fn("InitialConfig.write")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const initial = INITIAL_CONFIG[yield* ConfigHost]
  const catalogPath = yield* recipesDirectory()
  yield* fs.makeDirectory(catalogPath, { recursive: true })
  yield* Effect.forEach(
    initial.recipes,
    ([name, recipe]) => writeArtifactJson(path.join(catalogPath, `${name}.json`), Recipe, recipe),
    { concurrency: 1 },
  )
  yield* writeSettings({
    "default-recipe": initial.defaultRecipe,
    "default-lenses": INITIAL_DEFAULT_LENSES,
    favorites: initial.recipes.map(([name]) => name),
  })
  return initial
})
