import * as Array from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Order from "effect/Order"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { Recipe, RecipeName } from "../domain/recipe.ts"
import { recipesDirectory } from "./settings.ts"

// One invalid Recipe never disables the catalog: listing carries it as an
// entry with its path and Schema error; only selecting it fails (ADR 0005).
export type CatalogEntry = ValidRecipeEntry | InvalidRecipeEntry

export interface ValidRecipeEntry {
  readonly _tag: "ValidRecipe"
  readonly name: RecipeName
  readonly path: string
  readonly recipe: Recipe
}

export interface InvalidRecipeEntry {
  readonly _tag: "InvalidRecipe"
  readonly name: string
  readonly path: string
  readonly error: string
}

export class RecipeCatalogError extends Data.TaggedError("RecipeCatalogError")<{
  readonly path: string
  readonly reason: string
  readonly cause?: unknown
}> {}

// Selection failures name the catalog so the caller can list what exists;
// `available` carries the valid recipe names for the error message.
export class RecipeSelectionError extends Data.TaggedError(
  "RecipeSelectionError",
)<{
  readonly reason: string
  readonly available: ReadonlyArray<string>
}> {}

const decodeRecipe = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Recipe),
  // Unknown keys are invalid so a misspelled stage cannot silently inherit
  // the default seat (ADR 0005).
  { onExcessProperty: "error" },
)

const readEntry = Effect.fn("gauntlet.recipe_catalog.read_entry")(function* (
  directory: string,
  fileName: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const filePath = path.join(directory, fileName)
  const name = path.basename(fileName, ".json")
  if (!Schema.is(RecipeName)(name)) {
    return {
      _tag: "InvalidRecipe",
      name,
      path: filePath,
      error: "recipe filename is not lowercase-kebab-case",
    } satisfies InvalidRecipeEntry
  }
  const source = yield* fs.readFileString(filePath).pipe(
    Effect.mapError((cause) =>
      new RecipeCatalogError({
        path: filePath,
        reason: "could not read recipe",
        cause,
      })),
  )
  return yield* decodeRecipe(source).pipe(
    Effect.map((recipe): CatalogEntry => ({
      _tag: "ValidRecipe",
      name,
      path: filePath,
      recipe,
    })),
    Effect.catchTag("SchemaError", (failure) =>
      Effect.succeed<CatalogEntry>({
        _tag: "InvalidRecipe",
        name,
        path: filePath,
        error: failure.message,
      })),
  )
})

// The whole catalog, sorted by name: every *.json file in ~/.gauntlet/recipes
// has the same status — there is no built-in/custom split and no second
// source to merge (ADR 0005). A missing directory is an empty catalog.
export const listRecipes = Effect.fn("gauntlet.recipe_catalog.list")(
  function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const directory = yield* recipesDirectory()
    const entries = yield* fs.readDirectory(directory).pipe(
      Effect.catchTag("PlatformError", (failure) =>
        Predicate.isTagged("NotFound")(failure.reason)
          ? Effect.succeed([])
          : Effect.fail(
            new RecipeCatalogError({
              path: directory,
              reason: "could not list recipe catalog",
              cause: failure,
            }),
          )),
    )
    const fileNames = Array.sort(
      entries.filter((entry) => path.extname(entry) === ".json"),
      Order.String,
    )
    return yield* Effect.forEach(
      fileNames,
      (fileName) => readEntry(directory, fileName),
      { concurrency: 4 },
    )
  },
)

export const availableRecipeNames = (
  entries: ReadonlyArray<CatalogEntry>,
): ReadonlyArray<RecipeName> =>
  entries.filter((entry) => entry._tag === "ValidRecipe").map(
    (entry) => entry.name,
  )

// Select one named recipe for a review: an absent or invalid recipe fails
// here, before any Run is created, and names what is available instead.
export const selectRecipe = Effect.fn("gauntlet.recipe_catalog.select")(
  function* (name: string) {
    const entries = yield* listRecipes()
    const available = availableRecipeNames(entries)
    if (!Schema.is(RecipeName)(name)) {
      return yield* new RecipeSelectionError({
        reason: `recipe name is not lowercase-kebab-case: ${name}`,
        available,
      })
    }
    const entry = entries.find((candidate) => candidate.name === name)
    if (entry === undefined) {
      return yield* new RecipeSelectionError({
        reason: `recipe does not exist: ${name}`,
        available,
      })
    }
    if (entry._tag === "InvalidRecipe") {
      return yield* new RecipeSelectionError({
        reason: `recipe ${name} is invalid (${entry.path}): ${entry.error}`,
        available,
      })
    }
    return entry
  },
)
