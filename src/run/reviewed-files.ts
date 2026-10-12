import * as Arr from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"

// Reviewed files as lines, read from the review worktree. The paths come from
// model-authored findings, so one that leaves the worktree is never read, and
// one that isn't there (a deleted file, a misremembered name) is left out.
// One that can't be read is left out with a warning: the page draws without
// its excerpts rather than failing the review.
export const readReviewedFiles = Effect.fn("ReviewedFiles.read")(function* (
  directory: string,
  files: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const read = yield* Effect.forEach(files, (file) => {
    const inside = !path.isAbsolute(file) &&
      !path.relative(directory, path.join(directory, file)).startsWith("..")
    return inside
      ? fs.readFileString(path.join(directory, file)).pipe(
        Effect.map((text) => [file, text.replace(/\n$/, "").split("\n")] as const),
        Effect.asSome,
        Effect.catch((error) =>
          Predicate.isTagged(error.reason, "NotFound")
            ? Effect.succeedNone
            : Effect.logWarning(`page excerpt skipped, unreadable: ${file}`, error)
              .pipe(Effect.as(Option.none<readonly [string, Array<string>]>()))
        ),
      )
      : Effect.succeedNone
  }, { concurrency: "unbounded" })
  return new Map(Arr.getSomes(read))
})
