import { parseFrontmatter } from "@earendil-works/pi-coding-agent"
import * as Context from "effect/Context"
import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { Seat } from "../domain/recipe.ts"
import { LensName } from "../domain/review-plan.ts"

const LensFrontmatter = Schema.Struct({
  model: Schema.optionalKey(Seat),
  "needs-spec": Schema.optionalKey(Schema.Boolean),
  category: Schema.optionalKey(Schema.NonEmptyString),
})

export const LoadedLens = Schema.Struct({
  name: LensName,
  promptText: Schema.NonEmptyString,
  contentHash: Schema.NonEmptyString,
  modelOverride: Schema.optionalKey(Seat),
  needsSpec: Schema.Boolean,
  category: Schema.optionalKey(Schema.NonEmptyString),
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
    const allowed = new Set(["model", "needs-spec", "category"])
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
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest(
    "SHA-256",
    new TextEncoder().encode(source),
  ).pipe(
    Effect.mapError(contentLoadError(lensPath, "could not hash lens content")),
  )

  return LoadedLens.make({
    name: lensName,
    promptText,
    contentHash: Encoding.encodeHex(digest),
    ...(frontmatter.model === undefined
      ? {}
      : { modelOverride: frontmatter.model }),
    needsSpec: frontmatter["needs-spec"] ?? false,
    ...(frontmatter.category === undefined
      ? {}
      : { category: frontmatter.category }),
  })
})

export const loadFinderLens = Effect.fn("gauntlet.lens.load_finder_lens")(
  function* (name: string) {
    const root = yield* ContentDirectory
    const path = yield* Path.Path
    const lensesDirectory = path.join(root, "lenses")
    return yield* loadLens(lensesDirectory, name)
  },
)
