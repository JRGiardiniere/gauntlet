import { parseFrontmatter } from "@earendil-works/pi-coding-agent"
import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Order from "effect/Order"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { FinderClass } from "../domain/recipe.ts"
import { LensName } from "../domain/review-plan.ts"

// A lens is standard by omission or opts into exactly `interpretive`; arbitrary
// classes and concrete seats are invalid — the recipe maps the class to a
// seat, the lens never chooses a provider or model (ADR 0004). `category`
// is validated but not surfaced: it groups future lens listings and has no
// consumer today.
const LensFrontmatter = Schema.Struct({
  "finder-class": Schema.optionalKey(Schema.Literals(["interpretive"])),
  category: Schema.optionalKey(Schema.NonEmptyString),
})

export const LoadedLens = Schema.Struct({
  name: LensName,
  promptText: Schema.NonEmptyString,
  finderClass: FinderClass,
})
export interface LoadedLens extends Schema.Schema.Type<typeof LoadedLens> {}

export class ContentLoadError extends Data.TaggedError("ContentLoadError")<{
  readonly path: string
  readonly reason: string
  readonly cause?: unknown
}> {}

// The packaged content lives outside src/. Tests override this reference with
// a fixture-only content tree; no test is coupled to the shipped lens catalog.
export const ContentDirectory = Context.Reference<string>(
  "gauntlet/ContentDirectory",
  { defaultValue: () => `${import.meta.dirname}/../../content` },
)

const contentLoadError = (path: string, reason: string) => (cause?: unknown) =>
  new ContentLoadError({ path, reason, cause })

const decodeLensSource = (
  path: string,
  source: string,
): Effect.Effect<{
  readonly frontmatter: typeof LensFrontmatter.Type
  readonly promptText: string
}, ContentLoadError> =>
  Effect.gen(function* () {
    const normalized = source.replaceAll("\r\n", "\n").replaceAll("\r", "\n")
    if (
      normalized.startsWith("---\n") &&
      normalized.indexOf("\n---", 4) === -1
    ) {
      return yield* new ContentLoadError({
        path,
        reason: "frontmatter has no closing --- delimiter",
      })
    }
    const parsed = yield* Effect.try({
      try: () => parseFrontmatter(source),
      catch: contentLoadError(path, "frontmatter is not valid YAML"),
    })
    const allowed = new Set(["finder-class", "category"])
    for (const key of Object.keys(parsed.frontmatter)) {
      if (!allowed.has(key)) {
        return yield* new ContentLoadError({
          path,
          reason: `frontmatter field is not admitted: ${key}`,
        })
      }
    }

    const frontmatter = yield* Schema.decodeEffect(LensFrontmatter)(
      parsed.frontmatter,
    ).pipe(
      Effect.mapError(
        contentLoadError(path, "frontmatter does not match the lens format"),
      ),
    )
    const promptText = parsed.body
    if (promptText.trim() === "") {
      return yield* new ContentLoadError({
        path,
        reason: "lens prompt body is empty",
      })
    }
    return { frontmatter, promptText }
  })

export const loadLens = Effect.fn("gauntlet.lens.load")(function* (
  lensesDirectory: string,
  name: string,
) {
  const lensName = yield* Schema.decodeEffect(LensName)(name).pipe(
    Effect.mapError(contentLoadError(lensesDirectory, "invalid lens name")),
  )
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const lensPath = path.join(lensesDirectory, `${lensName}.md`)
  const source = yield* fs.readFileString(lensPath).pipe(
    Effect.mapError(contentLoadError(lensPath, "could not read lens")),
  )
  const { frontmatter, promptText } = yield* decodeLensSource(lensPath, source)

  return LoadedLens.make({
    name: lensName,
    promptText,
    finderClass: frontmatter["finder-class"] ?? "standard",
  })
})

const listLensNames = Effect.fn("gauntlet.lens.list_names")(function* (
  lensesDirectory: string,
  optionalDirectory: boolean,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const entries = yield* fs.readDirectory(lensesDirectory).pipe(
    Effect.catchTag("PlatformError", (failure) =>
      optionalDirectory && Predicate.isTagged("NotFound")(failure.reason)
        ? Effect.succeed([])
        : Effect.fail(
          new ContentLoadError({
            path: lensesDirectory,
            reason: "could not list lens directory",
            cause: failure,
          }),
        )),
  )
  return Array.sort(
    entries
      .filter((entry) => path.extname(entry) === ".md")
      .map((entry) => path.basename(entry, ".md")),
    Order.String,
  )
})

const loadLensDirectory = Effect.fn("gauntlet.lens.load_directory")(
  function* (lensesDirectory: string, optionalDirectory: boolean) {
    const names = yield* listLensNames(lensesDirectory, optionalDirectory)
    return yield* Effect.forEach(
      names,
      (name) => loadLens(lensesDirectory, name),
      { concurrency: 4 },
    )
  },
)

export interface FinderLensQuery {
  readonly repoRoot: string
  readonly names?: ReadonlyArray<string>
}

// Shipped and project-local lenses are ordinary directories using the same
// loader and format. Selection happens after the combined catalog is decoded.
export const loadFinderLenses = Effect.fn("gauntlet.lens.load_finder_lenses")(
  function* ({ names, repoRoot }: FinderLensQuery) {
    const contentRoot = yield* ContentDirectory
    const path = yield* Path.Path
    const shippedDirectory = path.join(contentRoot, "lenses")
    const projectDirectory = path.join(repoRoot, ".gauntlet", "lenses")
    const [shipped, project] = yield* Effect.all(
      [
        loadLensDirectory(shippedDirectory, false),
        loadLensDirectory(projectDirectory, true),
      ],
      { concurrency: 2 },
    )

    const catalog = new Map<LensName, LoadedLens>()
    for (const lens of [...shipped, ...project]) {
      if (catalog.has(lens.name)) {
        return yield* new ContentLoadError({
          path: projectDirectory,
          reason: `duplicate shipped/project lens name: ${lens.name}`,
        })
      }
      catalog.set(lens.name, lens)
    }

    const selectedNames = names === undefined
      ? [...catalog.keys()]
      : yield* Effect.forEach(names, (name) =>
        Schema.decodeEffect(LensName)(name).pipe(
          Effect.mapError(
            contentLoadError(repoRoot, `invalid selected lens name: ${name}`),
          ),
        ))
    const seen = new Set<LensName>()
    const selected: globalThis.Array<LoadedLens> = []
    for (const name of selectedNames) {
      if (seen.has(name)) continue
      seen.add(name)
      const lens = catalog.get(name)
      if (lens === undefined) {
        return yield* new ContentLoadError({
          path: repoRoot,
          reason: `selected lens does not exist: ${name}`,
        })
      }
      selected.push(lens)
    }
    return selected
  },
)
