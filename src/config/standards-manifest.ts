import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import { GOVERNING_STANDARDS_HEADING } from "../domain/finder-selection.ts"
import { chompLine, describeGitFailure, runGit } from "../target/git.ts"
import { gauntletHome } from "./settings.ts"

// A Standards Manifest is the user-owned, per-repository list of governing
// documents fed to the standards lens (#110): one newline-delimited path list
// under ~/.gauntlet/standards, never a file in the reviewed repository.

export class StandardsManifestError extends Data.TaggedError(
  "StandardsManifestError",
)<{
  readonly path: string
  readonly reason: string
  readonly cause?: unknown
}> {}

// The repository identity is the common git directory itself: exactly one
// per repository, shared by every worktree, present from commit zero, and
// independent of any remote — the key never changes when a remote appears
// later (#110).
const resolveRepoIdentity = Effect.fn(
  "gauntlet.standards.resolve_repo_identity",
)(function* (repoRoot: string) {
  return yield* runGit(repoRoot, [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]).pipe(
    Effect.map(chompLine),
    Effect.mapError((cause) =>
      new StandardsManifestError({
        path: repoRoot,
        reason: describeGitFailure(
          "could not resolve the repository identity for the Standards Manifest",
          cause,
        ),
        cause,
      })),
  )
})

const encodeRepoIdentity = (identity: string): string =>
  identity.replaceAll(/[^A-Za-z0-9]/g, "-")

export const standardsManifestPath = Effect.fn(
  "gauntlet.standards.manifest_path",
)(function* (repoRoot: string) {
  const path = yield* Path.Path
  const identity = yield* resolveRepoIdentity(repoRoot)
  const home = yield* gauntletHome().pipe(
    Effect.mapError((cause) =>
      new StandardsManifestError({
        path: cause.path,
        reason: cause.reason,
        cause,
      })),
  )
  return path.join(home, "standards", encodeRepoIdentity(identity))
})

// Repo-relative entries resolve against the reviewed checkout, so each
// worktree reads its own file versions; `~/` and absolute entries carry the
// shared cross-repository documents.
const resolveEntry = Effect.fn("gauntlet.standards.resolve_entry")(function* (
  manifestPath: string,
  repoRoot: string,
  entry: string,
) {
  const path = yield* Path.Path
  if (entry.startsWith("~/")) {
    const home = yield* Config.string("HOME").pipe(
      Effect.mapError((cause) =>
        new StandardsManifestError({
          path: manifestPath,
          reason: `HOME is not set; cannot resolve manifest entry ${entry}`,
          cause,
        })),
    )
    return path.join(home, entry.slice(2))
  }
  return path.isAbsolute(entry) ? entry : path.join(repoRoot, entry)
})

// Reads the manifest and assembles the Governing standards block Submission
// bakes into the standards lens's frozen prompt text. A missing or empty
// manifest is the unconfigured state (undefined — the lens will skip); a
// listed document that cannot be read is a configuration failure, surfaced
// before any Run exists.
export const loadGoverningStandardsBlock = Effect.fn(
  "gauntlet.standards.load_governing_block",
)(function* (repoRoot: string) {
  const fs = yield* FileSystem.FileSystem
  const manifestPath = yield* standardsManifestPath(repoRoot)
  const source = yield* fs.readFileString(manifestPath).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", (failure) =>
      Predicate.isTagged("NotFound")(failure.reason)
        ? Effect.succeed(Option.none<string>())
        : Effect.fail(
          new StandardsManifestError({
            path: manifestPath,
            reason: "could not read the Standards Manifest",
            cause: failure,
          }),
        )),
  )
  if (Option.isNone(source)) return undefined
  const entries = source.value
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "")
  if (entries.length === 0) return undefined

  const sections = yield* Effect.forEach(entries, (entry) =>
    Effect.gen(function* () {
      const documentPath = yield* resolveEntry(manifestPath, repoRoot, entry)
      const text = yield* fs.readFileString(documentPath).pipe(
        Effect.mapError((cause) =>
          new StandardsManifestError({
            path: documentPath,
            reason:
              `could not read a document listed in the Standards Manifest at ${manifestPath}`,
            cause,
          })),
      )
      return `### ${entry}\n\n${text.trim()}`
    }), { concurrency: 4 })
  return [
    GOVERNING_STANDARDS_HEADING,
    "The documents that govern how the changed code should be written, fed from the Standards Manifest. Judge each document's applicability from its own text.",
    ...sections,
  ].join("\n\n")
})
