import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import { ReviewSpecification } from "../domain/review-specification.ts"

export class SpecificationLoadError extends Data.TaggedError(
  "SpecificationLoadError",
)<{
  readonly path: string
  readonly reason: string
  readonly cause?: unknown
}> {}

// The Caller Addendum path of the Specification Source boundary (issue #73):
// read the explicitly named Markdown file once, before any Run exists, and
// return it as the complete ReviewSpecification. The caller selected this
// exact file, so a missing, unreadable, or empty file is a hard failure —
// never a quiet no-specification review.
export const loadCallerAddendum = Effect.fn(
  "gauntlet.specification.load_caller_addendum",
)(function* (invocationDirectory: string, specPath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const resolved = path.isAbsolute(specPath)
    ? specPath
    : path.resolve(invocationDirectory, specPath)
  const text = yield* fs.readFileString(resolved).pipe(
    Effect.mapError((failure) =>
      new SpecificationLoadError({
        path: resolved,
        reason: Predicate.isTagged("NotFound")(failure.reason)
          ? "caller addendum file does not exist"
          : "could not read caller addendum",
        cause: failure,
      })),
  )
  if (text.trim() === "") {
    return yield* new SpecificationLoadError({
      path: resolved,
      reason: "caller addendum is empty",
    })
  }
  return ReviewSpecification.make({
    documents: [{ role: "caller-addendum", provenance: resolved, text }],
    comments: [],
  })
})
