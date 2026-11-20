import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { pipe } from "effect/Function"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Record from "effect/Record"
import * as Schema from "effect/Schema"
import { FinderClass } from "../domain/recipe.ts"
import { LensName } from "../domain/review-plan.ts"

// A lens is specific by omission or opts into exactly `interpretive`; arbitrary
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

export class ContentLoadError extends Schema.TaggedError<
  ContentLoadError,
  { readonly brand: unique symbol }
>()("ContentLoadError", {
  path: Schema.String,
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

// Inside a compiled Bun executable every module URL sits under the virtual
// bundle root ($bunfs; ~BUN/%7EBUN on Windows) and the shipped content is an
// embedded asset tree next to the bundled entry, served through ordinary
// node:fs reads and directory listings (Bun >= 1.4).
export const isCompiledBinary = Array.some(["$bunfs", "~BUN", "%7EBUN"], (marker) =>
  import.meta.url.includes(marker))

// The packaged content lives outside src/: next to the bundled entry in a
// compiled binary, two levels above this module in a checkout. Tests override
// this reference with a fixture-only content tree; no test is coupled to the
// shipped lens catalog.
export const ContentDirectory = Context.Reference<string>(
  "gauntlet/ContentDirectory",
  {
    defaultValue: () =>
      isCompiledBinary
        ? `${import.meta.dirname}/content`
        : `${import.meta.dirname}/../../content`,
  },
)

const contentLoadError = (path: string, reason: string) => (cause?: unknown) =>
  ContentLoadError.make({ path, reason, cause })

// Lens frontmatter is flat `key: value` lines: a value may be quoted, and
// an unquoted one may end in a `# comment`.
const FRONTMATTER_LINE = /^([A-Za-z][\w-]*):[ \t]*(?:"([^"]*)"|'([^']*)'|(.*?))[ \t]*(?:[ \t]#.*)?$/

const parseFrontmatterLine = (line: string): Option.Option<readonly [string, string]> =>
  Option.map(
    Option.fromNullishOr(FRONTMATTER_LINE.exec(line)),
    ([, key = "", double, single, plain = ""]) => [key, double ?? single ?? plain] as const,
  )

const splitFrontmatter = (normalized: string) => {
  const end = normalized.startsWith("---\n") ? normalized.indexOf("\n---", 3) : -1

  if (end === -1) return { lines: Array.empty<string>(), body: normalized }

  return {
    lines: Array.filter(normalized.slice(4, end).split("\n"), (line) => line.trim() !== "" && !line.trimStart().startsWith("#")),
    body: normalized.slice(end + 4).trim(),
  }
}

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
      return yield* ContentLoadError.make({
        path,
        reason: "frontmatter has no closing --- delimiter",
      })
    }

    const parsed = splitFrontmatter(normalized.replace(/^\uFEFF/, ""))
    const entries: Array<readonly [string, string]> = []

    for (const line of parsed.lines) {
      const entry = parseFrontmatterLine(line)

      if (Option.isNone(entry)) {
        return yield* ContentLoadError.make({
          path,
          reason: `frontmatter line is not \`key: value\`: ${line}`,
        })
      }

      entries.push(entry.value)
    }

    const fields = Record.fromEntries(entries)
    const allowed = new Set(["finder-class", "category"])

    for (const key of Record.keys(fields)) {
      if (!allowed.has(key)) {
        return yield* ContentLoadError.make({
          path,
          reason: `frontmatter field is not admitted: ${key}`,
        })
      }
    }

    const finderClass = fields["finder-class"]

    const reason =
      Predicate.isString(finderClass) && finderClass !== "interpretive"
        ? `finder-class admits exactly "interpretive" (specific is by omission); got "${finderClass}"`
        : "frontmatter does not match the lens format"

    const frontmatter = yield* Schema.decodeEffect(LensFrontmatter)(
      fields,
    ).pipe(
      Effect.mapError(contentLoadError(path, reason)),
    )

    const promptText = parsed.body

    if (promptText.trim() === "") {
      return yield* ContentLoadError.make({
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
    finderClass: frontmatter["finder-class"] ?? "specific",
  })
})

const listLensNames = Effect.fn("gauntlet.lens.list_names")(function* (
  lensesDirectory: string,
  optionalDirectory: boolean,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const entries: ReadonlyArray<string> = yield* fs.readDirectory(lensesDirectory).pipe(
    Effect.catchTag("PlatformError", (failure) =>
      optionalDirectory && Predicate.isTagged("NotFound")(failure.reason)
        ? Effect.succeed([])
        : Effect.fail(
          ContentLoadError.make({
            path: lensesDirectory,
            reason: "could not list lens directory",
            cause: failure,
          }),
        )),
  )

  return Array.sort(
    pipe(
      entries,
      Array.filter((entry) => path.extname(entry) === ".md"),
      Array.map((entry) => path.basename(entry, ".md")),
    ),
    Order.String,
  )
})

interface FinderLensQuery {
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
          return yield* ContentLoadError.make({
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
    const selectedSources: globalThis.Array<LensSource> = []

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
        return yield* ContentLoadError.make({
          path: repoRoot,
          reason: `selected lens does not exist: ${decodedName}`,
        })
      }

      selectedSources.push(source)
    }

    return yield* Effect.forEach(
      selectedSources,
      (source) => loadLens(source.directory, source.name),
      { concurrency: 4 },
    )
  },
)

export const loadFinderLensCatalog = Effect.fn(
  "gauntlet.lens.load_finder_catalog",
)(function* (repoRoot: string) {
  const catalog = yield* discoverFinderLensSources(repoRoot)

  const sources = Array.sort(
    [...catalog.values()],
    Order.mapInput(Order.String, (source: LensSource) => source.name),
  )

  return yield* Effect.forEach(
    sources,
    (source) => loadLens(source.directory, source.name),
    { concurrency: 4 },
  )
})
