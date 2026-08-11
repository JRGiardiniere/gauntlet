import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"

export class ArtifactWriteError extends Data.TaggedError("ArtifactWriteError")<{
  readonly path: string
  readonly cause: unknown
}> {}

const artifactWriteError = (path: string) => (cause: unknown) =>
  new ArtifactWriteError({ path, cause })

export const readOptionalArtifactText = Effect.fn(
  "gauntlet.artifact.read_optional_text",
)(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (failure) =>
      Predicate.isTagged("NotFound")(failure.reason)
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(failure)),
  )
})

// Atomic artifact write: temp file + rename in the artifact's own directory,
// never a system temp dir — cross-device rename fails (ADR 0003). A write
// can therefore never half-happen; a crash leaves at worst a stray temp file
// that validity checks ignore.
export const writeArtifactText = Effect.fn("gauntlet.artifact.write_text")(
  function* (path: string, text: string) {
    const fs = yield* FileSystem.FileSystem
    const suffix = yield* Random.nextIntBetween(0, 0xffffff)
    const tempPath = `${path}.tmp-${suffix.toString(16)}`
    yield* fs.writeFileString(tempPath, text).pipe(
      Effect.andThen(fs.rename(tempPath, path)),
      Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignoreCause)),
      Effect.mapError(artifactWriteError(path)),
    )
  },
)

export const writeArtifactJson = Effect.fn("gauntlet.artifact.write_json")(
  function* <S extends Schema.Top>(path: string, schema: S, value: S["Type"]) {
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(schema, { space: 2 }),
    )(value).pipe(Effect.mapError(artifactWriteError(path)))
    yield* writeArtifactText(path, `${json}\n`)
  },
)
