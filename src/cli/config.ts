import * as Console from "effect/Console"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Config from "effect/Config"
import * as Result from "effect/Result"
import * as Argument from "effect/unstable/cli/Argument"
import * as Command from "effect/unstable/cli/Command"
import { Recipe, type RecipeName } from "../domain/recipe.ts"
import {
  availableRecipeNames,
  type CatalogEntry,
  listRecipes,
  RecipeSelectionError,
  selectRecipe,
} from "../config/recipe-catalog.ts"
import {
  defaultRunsRoot,
  loadSettings,
  recipesDirectory,
  type Settings,
  settingsPath,
  writeSettings,
} from "../config/settings.ts"
import { writeArtifactJson } from "../run/artifact.ts"

export class ConfigCommandError extends Data.TaggedError("ConfigCommandError")<{
  readonly reason: string
}> {}

// The initial catalog mirrors the old reviewer's MODEL_TIERS: quick keeps the
// manual luna:high downstream tune under sol:low finders; low/medium/high run
// one seat top to bottom (John's 2026-08-10 uniform-preset call). After init
// these files are entirely user-owned; nothing here is re-read or replenished.
const SEEDED_RECIPES: ReadonlyArray<readonly [RecipeName, Recipe]> = [
  [
    "quick",
    Recipe.make({
      default: "openai-codex/gpt-5.6-luna:high",
      finders: "openai-codex/gpt-5.6-sol:low",
    }),
  ],
  ["low", Recipe.make({ default: "openai-codex/gpt-5.6-luna:high" })],
  ["medium", Recipe.make({ default: "openai-codex/gpt-5.6-sol:medium" })],
  ["high", Recipe.make({ default: "openai-codex/gpt-5.6-sol:high" })],
]

const INITIAL_DEFAULT_RECIPE: RecipeName = "medium"

const SETTINGS_KEYS = "default-recipe, favorites, runs-root"

// One line per recipe: the default seat plus whichever overrides are present,
// in the recipe's admitted field order.
const summarizeRecipe = (recipe: Recipe): string =>
  [
    `default ${recipe.default}`,
    ...(["finders", "deep-finders", "pool", "verification", "judgment"] as const)
      .filter((field) => recipe[field] !== undefined)
      .map((field) => `${field} ${recipe[field]}`),
  ].join(" · ")

const describeEntry = (
  entry: CatalogEntry,
  defaultRecipe: string | undefined,
): string =>
  entry._tag === "ValidRecipe"
    ? `- ${entry.name}${
      entry.name === defaultRecipe ? " (default recipe)" : ""
    } — ${summarizeRecipe(entry.recipe)}`
    : `- ${entry.name} — invalid (${entry.path}): ${entry.error}`

// Bare `gauntlet config` is the discoverability surface (ADR 0005): it prints
// the edit locations and the whole catalog — favorites in configured order,
// the rest alphabetically — and explains inconsistencies instead of failing,
// so a malformed settings file can still be found and repaired.
const printConfiguration = Effect.fn("gauntlet.cli.config_print")(function* () {
  const path = yield* settingsPath()
  const catalogPath = yield* recipesDirectory()
  const entries = yield* listRecipes()
  const settingsResult = yield* Effect.result(loadSettings())

  const lines: Array<string> = []
  if (Result.isFailure(settingsResult)) {
    lines.push(`settings: ${path} — ${settingsResult.failure.reason}`)
  } else if (Option.isNone(settingsResult.success)) {
    lines.push(`settings: ${path} (missing — run \`gauntlet config init\`)`)
  } else {
    lines.push(`settings: ${path}`)
  }
  lines.push(`recipe catalog: ${catalogPath}`)

  const settings = Result.isFailure(settingsResult)
    ? Option.none<Settings>()
    : settingsResult.success
  const runsRoot = Option.match(settings, {
    onNone: () => undefined,
    onSome: (value) => value["runs-root"],
  })
  lines.push(`runs root: ${runsRoot ?? (yield* defaultRunsRoot())}`)

  const defaultRecipe = Option.match(settings, {
    onNone: () => undefined,
    onSome: (value) => value["default-recipe"],
  })
  const byName = new Map(entries.map((entry) => [entry.name, entry]))

  if (Option.isSome(settings)) {
    const favorites = settings.value.favorites
    const missing = favorites.filter((name) => !byName.has(name))
    if (
      defaultRecipe !== undefined &&
      byName.get(defaultRecipe)?._tag !== "ValidRecipe"
    ) {
      lines.push(
        `warning: default-recipe ${defaultRecipe} does not name an available valid recipe`,
      )
    }
    if (missing.length > 0) {
      lines.push(`warning: favorites name missing recipes: ${missing.join(", ")}`)
    }
    const present = favorites.filter((name) => byName.has(name))
    if (present.length > 0) {
      lines.push("", "favorites:")
      for (const name of present) {
        const entry = byName.get(name)
        if (entry !== undefined) lines.push(describeEntry(entry, defaultRecipe))
      }
    }
    const favoriteSet = new Set(present)
    const remaining = entries.filter((entry) => !favoriteSet.has(entry.name))
    lines.push("", "recipes:")
    if (remaining.length === 0) lines.push("- none")
    for (const entry of remaining) {
      lines.push(describeEntry(entry, defaultRecipe))
    }
  } else {
    lines.push("", "recipes:")
    if (entries.length === 0) {
      lines.push("- none (run `gauntlet config init`)")
    }
    for (const entry of entries) {
      lines.push(describeEntry(entry, defaultRecipe))
    }
  }
  yield* Console.log(lines.join("\n"))
})

// `config init` is the one explicit creator of configuration: it seeds a
// fresh catalog and settings, is a no-op when they are already valid, and
// refuses a partial state with repair guidance — never an overwrite (ADR 0005).
const runInit = Effect.fn("gauntlet.cli.config_init")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const settingsFile = yield* settingsPath()
  const catalogPath = yield* recipesDirectory()
  const settingsExists = yield* fs.exists(settingsFile).pipe(
    Effect.mapError((cause) =>
      new ConfigCommandError({
        reason: `could not inspect ${settingsFile}: ${String(cause)}`,
      })),
  )
  const entries = yield* listRecipes()

  if (!settingsExists && entries.length === 0) {
    yield* fs.makeDirectory(catalogPath, { recursive: true }).pipe(
      Effect.mapError((cause) =>
        new ConfigCommandError({
          reason: `could not create ${catalogPath}: ${String(cause)}`,
        })),
    )
    yield* Effect.forEach(
      SEEDED_RECIPES,
      ([name, recipe]) =>
        writeArtifactJson(path.join(catalogPath, `${name}.json`), Recipe, recipe),
      { concurrency: 1 },
    )
    yield* writeSettings({
      "default-recipe": INITIAL_DEFAULT_RECIPE,
      favorites: SEEDED_RECIPES.map(([name]) => name),
    })
    yield* Console.log(
      [
        `initialized ${catalogPath} with recipes ${
          SEEDED_RECIPES.map(([name]) => name).join(", ")
        }`,
        `default-recipe: ${INITIAL_DEFAULT_RECIPE} · favorites: ${
          SEEDED_RECIPES.map(([name]) => name).join(", ")
        }`,
        "the seeded files are yours to edit; init never touches them again",
      ].join("\n"),
    )
    return
  }

  // Anything between fresh and valid is partial: refuse with the precise
  // repair, never overwrite, replenish, or silently heal (issue #24).
  if (!settingsExists) {
    return yield* new ConfigCommandError({
      reason:
        `recipe catalog ${catalogPath} already has recipes but ${settingsFile} is missing — ` +
        `write settings.json ({"default-recipe": <name>, "favorites": []}) or remove the catalog and rerun init`,
    })
  }
  const settings = yield* loadSettings().pipe(
    Effect.mapError((failure) =>
      new ConfigCommandError({
        reason: `${failure.reason} (${failure.path}) — fix or delete settings.json, then rerun init`,
      })),
  )
  const defaultRecipe = Option.map(settings, (value) => value["default-recipe"])
  if (Option.isNone(defaultRecipe)) {
    // exists() said the file is there; a concurrent delete is the only path
    // here, and re-running init is the honest advice.
    return yield* new ConfigCommandError({
      reason: `${settingsFile} disappeared while init ran — rerun init`,
    })
  }
  const entry = entries.find((candidate) =>
    candidate.name === defaultRecipe.value
  )
  if (entry === undefined || entry._tag === "InvalidRecipe") {
    return yield* new ConfigCommandError({
      reason:
        `default-recipe ${defaultRecipe.value} does not name an available valid recipe — ` +
        `\`gauntlet config set default-recipe <name>\` or fix ${catalogPath}/${defaultRecipe.value}.json`,
    })
  }
  yield* Console.log(
    "configuration already initialized — nothing to do (run `gauntlet config` to inspect it)",
  )
})

// set/unset mutate an existing settings file only; init is the sole creator.
const requireSettings = Effect.fn("gauntlet.cli.config_require_settings")(
  function* () {
    const settings = yield* loadSettings()
    if (Option.isNone(settings)) {
      const path = yield* settingsPath()
      return yield* new ConfigCommandError({
        reason: `no settings file at ${path} — run \`gauntlet config init\` first`,
      })
    }
    return settings.value
  },
)

const requireExactlyOne = (
  key: string,
  values: ReadonlyArray<string>,
): Effect.Effect<string, ConfigCommandError> => {
  const [value] = values
  return values.length === 1 && value !== undefined
    ? Effect.succeed(value)
    : Effect.fail(
      new ConfigCommandError({
        reason: `config set ${key} takes exactly one value`,
      }),
    )
}

const normalizeRunsRoot = Effect.fn("gauntlet.cli.config_runs_root")(function* (
  value: string,
) {
  const path = yield* Path.Path
  if (value.startsWith("~/") || value === "~") {
    const home = yield* Config.string("HOME")
    return path.normalize(path.join(home, value.slice(1)))
  }
  if (path.isAbsolute(value)) return path.normalize(value)
  return yield* new ConfigCommandError({
    reason:
      `runs-root must be an absolute or ~/ path, got: ${value} — ` +
      "a working-directory-relative runs root would change meaning per invocation",
  })
})

const noSuchKey = (verb: string, key: string) =>
  new ConfigCommandError({
    reason: `unknown settings key for config ${verb}: ${key} (keys: ${SETTINGS_KEYS})`,
  })

const runSet = Effect.fn("gauntlet.cli.config_set")(function* (
  key: string,
  values: ReadonlyArray<string>,
) {
  const settings = yield* requireSettings()
  switch (key) {
    case "default-recipe": {
      const name = yield* requireExactlyOne(key, values)
      // Selection validates availability: a dangling default would make every
      // unnamed review fail later, so it is rejected here.
      const entry = yield* selectRecipe(name)
      yield* writeSettings({ ...settings, "default-recipe": entry.name })
      yield* Console.log(`default-recipe = ${entry.name}`)
      return
    }
    case "favorites": {
      if (values.length === 0) {
        return yield* new ConfigCommandError({
          reason:
            "config set favorites takes one or more recipe names (config unset favorites clears the list)",
        })
      }
      if (new Set(values).size !== values.length) {
        return yield* new ConfigCommandError({
          reason: `favorites must be distinct: ${values.join(", ")}`,
        })
      }
      const names = yield* Effect.forEach(
        values,
        (name) => selectRecipe(name).pipe(Effect.map((entry) => entry.name)),
        { concurrency: 1 },
      )
      yield* writeSettings({ ...settings, favorites: names })
      yield* Console.log(`favorites = ${names.join(", ")}`)
      return
    }
    case "runs-root": {
      const value = yield* requireExactlyOne(key, values)
      const normalized = yield* normalizeRunsRoot(value)
      yield* writeSettings({ ...settings, "runs-root": normalized })
      yield* Console.log(`runs-root = ${normalized}`)
      return
    }
    default:
      return yield* noSuchKey("set", key)
  }
})

const runUnset = Effect.fn("gauntlet.cli.config_unset")(function* (
  key: string,
) {
  const settings = yield* requireSettings()
  switch (key) {
    case "default-recipe":
      // An unnamed review must always have a Default Recipe to resolve;
      // pointing it elsewhere is the only supported change (issue #24).
      return yield* new ConfigCommandError({
        reason:
          "default-recipe cannot be unset — set a different recipe with `gauntlet config set default-recipe <name>`",
      })
    case "favorites":
      yield* writeSettings({ ...settings, favorites: [] })
      yield* Console.log("favorites cleared")
      return
    case "runs-root": {
      yield* writeSettings({
        "default-recipe": settings["default-recipe"],
        favorites: settings.favorites,
      })
      yield* Console.log(`runs-root = ${yield* defaultRunsRoot()} (default)`)
      return
    }
    default:
      return yield* noSuchKey("unset", key)
  }
})

const init = Command.make("init", {}, () => runInit()).pipe(
  Command.withDescription(
    "Create the initial recipe catalog and settings (no-op when already valid)",
  ),
)

const set = Command.make(
  "set",
  {
    key: Argument.string("key"),
    values: Argument.string("value").pipe(Argument.variadic()),
  },
  ({ key, values }) => runSet(key, values),
).pipe(
  Command.withDescription(
    `Set a settings key (${SETTINGS_KEYS})`,
  ),
)

const unset = Command.make(
  "unset",
  { key: Argument.string("key") },
  ({ key }) => runUnset(key),
).pipe(
  Command.withDescription(
    "Clear a settings key (favorites, runs-root; default-recipe is rejected)",
  ),
)

export const configCommand = Command.make(
  "config",
  {},
  () => printConfiguration(),
).pipe(
  Command.withSubcommands([init, set, unset]),
  Command.withDescription(
    "Print the settings path, recipe catalog, and all recipes",
  ),
)

// Review-side selection: positional recipe, otherwise the configured Default
// Recipe — nothing else selects one, and failing lists what exists (ADR 0005).
export const resolveReviewRecipe = Effect.fn(
  "gauntlet.cli.resolve_review_recipe",
)(function* (positional: Option.Option<string>) {
  if (Option.isSome(positional)) {
    return yield* selectRecipe(positional.value)
  }
  const settings = yield* loadSettings()
  if (Option.isNone(settings)) {
    const entries = yield* listRecipes()
    return yield* new RecipeSelectionError({
      reason:
        "no default recipe is configured — pass a recipe (`gauntlet review <recipe>`) or run `gauntlet config init`",
      available: availableRecipeNames(entries),
    })
  }
  const name = settings.value["default-recipe"]
  return yield* selectRecipe(name).pipe(
    Effect.catchTag("RecipeSelectionError", (failure) =>
      new RecipeSelectionError({
        reason: `configured default-recipe is unusable — ${failure.reason}`,
        available: failure.available,
      })),
  )
})

export const renderAvailable = (
  available: ReadonlyArray<string>,
): string =>
  available.length === 0
    ? "; the recipe catalog is empty"
    : `; available recipes: ${available.join(", ")}`
