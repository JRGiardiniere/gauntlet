import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { RecipeName } from "../domain/recipe.ts"
import { writeArtifactJson } from "../run/artifact.ts"

// `runs-root` is persisted as a normalized absolute path; `config set` owns
// `~/` expansion. Direct edits that store anything else are invalid rather
// than silently resolved against the invocation directory.
export const RunsRoot = Schema.String.check(Schema.isPattern(/^\//))

// The standing choices in ~/.gauntlet/settings.json (ADR 0005): the Default
// Recipe and ordered Favorites are settings metadata, never recipe anatomy.
export const Settings = Schema.Struct({
  "default-recipe": RecipeName,
  favorites: Schema.Array(RecipeName),
  "runs-root": Schema.optionalKey(RunsRoot),
})
export type Settings = typeof Settings.Type

export class SettingsError extends Data.TaggedError("SettingsError")<{
  readonly path: string
  readonly reason: string
  readonly cause?: unknown
}> {}

// Recipes and settings live under ~/.gauntlet (ADR 0005). HOME is read via
// Config so tests point it at a temp directory instead of mutating env.
export const gauntletHome = Effect.fn("gauntlet.settings.home")(function* () {
  const path = yield* Path.Path
  const home = yield* Config.string("HOME").pipe(
    Effect.mapError((cause) =>
      new SettingsError({
        path: "$HOME",
        reason: "HOME is not set; cannot locate ~/.gauntlet",
        cause,
      })),
  )
  return path.join(home, ".gauntlet")
})

export const settingsPath = Effect.fn("gauntlet.settings.path")(function* () {
  const path = yield* Path.Path
  return path.join(yield* gauntletHome(), "settings.json")
})

export const recipesDirectory = Effect.fn(
  "gauntlet.settings.recipes_directory",
)(function* () {
  const path = yield* Path.Path
  return path.join(yield* gauntletHome(), "recipes")
})

export const defaultRunsRoot = Effect.fn(
  "gauntlet.settings.default_runs_root",
)(function* () {
  const path = yield* Path.Path
  return path.join(yield* gauntletHome(), "runs")
})

const decodeSettings = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Settings),
  // Strict settings: an unknown key is a typo, not a forward-compatible
  // extension — failing beats silently ignoring a misspelled standing choice.
  { onExcessProperty: "error" },
)

// A missing file is the unconfigured state (`config init` creates it); any
// other read or decode failure is surfaced, never defaulted (house rule 22).
export const loadSettings = Effect.fn("gauntlet.settings.load")(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* settingsPath()
  const source = yield* fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (failure) =>
      Predicate.isTagged("NotFound")(failure.reason)
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(
          new SettingsError({
            path,
            reason: "could not read settings",
            cause: failure,
          }),
        )),
  )
  if (Option.isNone(source)) return Option.none<Settings>()
  const settings = yield* decodeSettings(source.value).pipe(
    Effect.mapError((cause) =>
      new SettingsError({
        path,
        reason: `settings are invalid: ${cause.message}`,
        cause,
      })),
  )
  return Option.some(settings)
})

// Settings writes reuse the run-artifact atomic sibling-temp-and-rename
// mechanism; the personal-tool use case does not justify locking (ADR 0005).
export const writeSettings = Effect.fn("gauntlet.settings.write")(function* (
  settings: Settings,
) {
  const path = yield* settingsPath()
  yield* writeArtifactJson(path, Settings, settings)
})

// Runs land under the `runs-root` setting when present, else ~/.gauntlet/runs.
// Invalid settings fail loudly here: guessing a runs root would scatter runs.
export const resolveRunsRoot = Effect.fn(
  "gauntlet.settings.resolve_runs_root",
)(function* () {
  const settings = yield* loadSettings()
  const configured = Option.match(settings, {
    onNone: () => undefined,
    onSome: (value) => value["runs-root"],
  })
  return configured ?? (yield* defaultRunsRoot())
})
