import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { Recipe, type RecipeName } from "../domain/recipe.ts"
import type { LensName } from "../domain/review-plan.ts"
import { writeArtifactJson } from "../run/artifact.ts"
import { recipesDirectory, writeSettings } from "./settings.ts"

// What a fresh configuration holds: `config init` writes it. After that the
// files are user-owned; nothing re-reads or replenishes them, and only
// `gauntlet upgrade` touches them, moving Luna/Terra/Sol seats forward (#121).
// Every recipe runs one seat top to bottom (John's 2026-08-10 uniform-preset
// call); quick is Terra in Fast mode (2026-11-18).
export const INITIAL_RECIPES: ReadonlyArray<readonly [RecipeName, Recipe]> = [
  ["quick", Recipe.make({ default: "openai/gpt-6.1-terra:high+fast" })],
  ["low", Recipe.make({ default: "openai/gpt-6-luna:high" })],
  ["medium", Recipe.make({ default: "openai/gpt-6.2-sol:medium" })],
  ["high", Recipe.make({ default: "openai/gpt-6.2-sol:high" })],
]
export const INITIAL_DEFAULT_RECIPE: RecipeName = "medium"

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

// Writes the initial recipes and settings; callers check freshness first.
export const writeInitialConfig = Effect.fn("InitialConfig.write")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const catalogPath = yield* recipesDirectory()
  yield* fs.makeDirectory(catalogPath, { recursive: true })
  yield* Effect.forEach(
    INITIAL_RECIPES,
    ([name, recipe]) => writeArtifactJson(path.join(catalogPath, `${name}.json`), Recipe, recipe),
    { concurrency: 1 },
  )
  yield* writeSettings({
    "default-recipe": INITIAL_DEFAULT_RECIPE,
    "default-lenses": INITIAL_DEFAULT_LENSES,
    favorites: Array.map(INITIAL_RECIPES, ([name]) => name),
  })
})
