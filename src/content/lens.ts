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

    const finderClass = parsed.frontmatter["finder-class"]
    const reason =
      Predicate.isString(finderClass) && finderClass !== "interpretive"
        ? `finder-class admits exactly "interpretive" (standard is by omission); got "${finderClass}"`
        : "frontmatter does not match the lens format"
    const frontmatter = yield* Schema.decodeEffect(LensFrontmatter)(
      parsed.frontmatter,
    ).pipe(
      Effect.mapError(contentLoadError(path, reason)),
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

export interface FinderLensQuery {
  readonly repoRoot: string
  readonly names: ReadonlyArray<string>
}

interface LensSource {
  readonly directory: string
  readonly name: LensName
}

// Discovery records only identities and locations. Review selection decodes
// the chosen Markdown, while bare config deliberately decodes the full catalog
// as its fail-fast validation surface.
const discoverFinderLensSources = Effect.fn(
  "gauntlet.lens.discover_finder_sources",
)(function* (repoRoot: string) {
    const contentRoot = yield* ContentDirectory
    const path = yield* Path.Path
    const shippedDirectory = path.join(contentRoot, "lenses")
    const projectDirectory = path.join(repoRoot, ".gauntlet", "lenses")
    const [shippedNames, projectNames] = yield* Effect.all(
      [
        listLensNames(shippedDirectory, false),
        listLensNames(projectDirectory, true),
      ],
      { concurrency: 2 },
    )

    const catalog = new Map<LensName, LensSource>()
    for (const [directory, names] of [
      [shippedDirectory, shippedNames],
      [projectDirectory, projectNames],
    ] as const) {
      for (const name of names) {
        const decodedName = yield* Schema.decodeEffect(LensName)(name).pipe(
          Effect.mapError(
            contentLoadError(directory, `invalid lens filename: ${name}.md`),
          ),
        )
        if (catalog.has(decodedName)) {
          return yield* new ContentLoadError({
            path: projectDirectory,
            reason: `duplicate shipped/project lens name: ${decodedName}`,
          })
        }
        catalog.set(decodedName, { directory, name: decodedName })
      }
    }
    return catalog
  })

// Shipped and project-local lenses remain one effective availability catalog,
// but only names chosen by Default Lenses or the exact caller override are
// decoded for a review. A project-local file is therefore available, not
// implicitly selected.
export const loadFinderLenses = Effect.fn("gauntlet.lens.load_finder_lenses")(
  function* ({ names, repoRoot }: FinderLensQuery) {
    const catalog = yield* discoverFinderLensSources(repoRoot)
    const seen = new Set<LensName>()
    const selected: globalThis.Array<LoadedLens> = []
    for (const name of names) {
      const decodedName = yield* Schema.decodeEffect(LensName)(name).pipe(
        Effect.mapError(
          contentLoadError(repoRoot, `invalid selected lens name: ${name}`),
        ),
      )
      if (seen.has(decodedName)) continue
      seen.add(decodedName)
      const source = catalog.get(decodedName)
      if (source === undefined) {
        return yield* new ContentLoadError({
          path: repoRoot,
          reason: `selected lens does not exist: ${decodedName}`,
        })
      }
      selected.push(yield* loadLens(source.directory, source.name))
    }
    return selected
  },
)

export const loadFinderLensCatalog = Effect.fn(
  "gauntlet.lens.load_finder_catalog",
)(function* (repoRoot: string) {
  const catalog = yield* discoverFinderLensSources(repoRoot)
  const names = Array.sort([...catalog.keys()], Order.String)
  return yield* loadFinderLenses({ repoRoot, names })
})
