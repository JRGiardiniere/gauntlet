import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import * as Predicate from "effect/Predicate"
import * as Random from "effect/Random"
import * as Schema from "effect/Schema"

export class ArtifactWriteError extends Data.TaggedError("ArtifactWriteError")<{
  readonly path: string
  readonly cause: unknown
}> {}

// The one rendering of a filesystem or process failure:
// `<operation> failed on <path>: <reason>`. Node's errno failures carry no
// description, so their code stands in for one.
export const describePlatformError = (
  failure: PlatformError.PlatformError,
): string => {
  const { reason } = failure
  const operation = `${reason.module}.${reason.method}`
  if (reason._tag === "BadArgument") {
    return `${operation} failed: ${reason.description ?? "bad argument"}`
  }
  const code = Predicate.hasProperty(reason.cause, "code") &&
      Predicate.isString(reason.cause.code)
    ? ` (${reason.cause.code})`
    : ""
  const detail = reason.description ?? `${reason._tag}${code}`
  return reason.pathOrDescriptor === undefined
    ? `${operation} failed: ${detail}`
    : `${operation} failed on ${String(reason.pathOrDescriptor)}: ${detail}`
}

export const describeArtifactWrite = (failure: ArtifactWriteError): string =>
  `failed to write ${failure.path}: ${
    PlatformError.isPlatformError(failure.cause)
      ? describePlatformError(failure.cause)
      : String(failure.cause)
  }`

const artifactWriteError = (path: string) => (cause: unknown) =>
  new ArtifactWriteError({ path, cause })

export const readOptionalArtifactText = Effect.fn(
  "gauntlet.artifact.read_optional_text",
)(function* (path: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.readFileString(path).pipe(
    Effect.asSome,
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
export const writeArtifactAtomically = Effect.fn("gauntlet.artifact.write")(
  function* (
    path: string,
    write: (
      fs: FileSystem.FileSystem,
      tempPath: string,
    ) => Effect.Effect<void, unknown>,
  ) {
    const fs = yield* FileSystem.FileSystem
    const suffix = yield* Random.nextIntBetween(0, 0xffffff)
    const tempPath = `${path}.tmp-${suffix.toString(16)}`
    yield* write(fs, tempPath).pipe(
      Effect.andThen(fs.rename(tempPath, path)),
      Effect.onError(() => fs.remove(tempPath).pipe(Effect.ignoreCause)),
      Effect.mapError(artifactWriteError(path)),
    )
  },
)

export const writeArtifactText = (path: string, text: string) =>
  writeArtifactAtomically(path, (fs, tempPath) =>
    fs.writeFileString(tempPath, text))

export const writeArtifactBytes = (path: string, bytes: Uint8Array) =>
  writeArtifactAtomically(path, (fs, tempPath) => fs.writeFile(tempPath, bytes))

export const writeArtifactJson = Effect.fn("gauntlet.artifact.write_json")(
  function* <S extends Schema.Top>(path: string, schema: S, value: S["Type"]) {
    const json = yield* Schema.encodeEffect(
      Schema.fromJsonString(schema, { space: 2 }),
    )(value).pipe(Effect.mapError(artifactWriteError(path)))
    yield* writeArtifactText(path, `${json}\n`)
  },
)
