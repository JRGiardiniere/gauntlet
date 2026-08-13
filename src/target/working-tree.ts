import * as Crypto from "effect/Crypto"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Encoding from "effect/Encoding"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  chompLine,
  describeGitFailure,
  type GitCommandError,
  runGit,
} from "./git.ts"

// The working tree cannot yield a ReviewTarget at all — not a repo, no HEAD
// to diff against, or nothing changed. "Could not review", exit 1.
export class TargetUnresolvable extends Data.TaggedError("TargetUnresolvable")<{
  readonly reason: string
  readonly cause: unknown
}> {}

const explainGit = (reason: string) =>
<A, R>(self: Effect.Effect<A, GitCommandError, R>): Effect.Effect<A, TargetUnresolvable, R> =>
  Effect.catchTag(self, "GitCommandError", (cause) =>
    Effect.fail(
      new TargetUnresolvable({
        reason: describeGitFailure(reason, cause),
        cause,
      }),
    ))

const explainUntrackedFile = (reason: string) =>
<A, R>(
  self: Effect.Effect<A, { readonly _tag: "PlatformError" }, R>,
): Effect.Effect<A, TargetUnresolvable, R> =>
  Effect.catchTag(self, "PlatformError", (cause) =>
    Effect.fail(new TargetUnresolvable({ reason, cause })))

// Git already governs tracked files. Untracked files larger than this are
// dropped from the digest set and named in a scope-degradation warning.
const UNTRACKED_SIZE_CAP = FileSystem.MiB(10)

const digestBytes = Effect.fn(
  "gauntlet.working_tree.digest_bytes",
)(function* (bytes: Uint8Array, relativePath: string) {
  const crypto = yield* Crypto.Crypto
  const digest = yield* crypto.digest("SHA-256", bytes).pipe(
    explainUntrackedFile(`could not digest untracked file ${relativePath}`),
  )
  return Encoding.encodeHex(digest)
})

const inspectUntrackedFile = Effect.fn(
  "gauntlet.working_tree.inspect_untracked_file",
)(function* (repoRoot: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absolutePath = path.join(repoRoot, relativePath)
  // stat follows symlinks; readLink first so a dangling or directory-target
  // link hashes as itself instead of aborting resolution.
  const linkTarget = yield* fs.readLink(absolutePath).pipe(Effect.option)
  if (Option.isSome(linkTarget)) {
    return {
      kind: "included" as const,
      path: relativePath,
      digest: yield* digestBytes(
        new TextEncoder().encode(linkTarget.value),
        relativePath,
      ),
    }
  }
  const info = yield* fs.stat(absolutePath).pipe(
    explainUntrackedFile(`could not inspect untracked file ${relativePath}`),
  )
  if (info.type !== "File") {
    return { kind: "named" as const, path: relativePath }
  }
  if (info.size > UNTRACKED_SIZE_CAP) {
    return { kind: "oversized" as const, path: relativePath }
  }
  const bytes = yield* fs.readFile(absolutePath).pipe(
    explainUntrackedFile(`could not read untracked file ${relativePath}`),
  )
  return {
    kind: "included" as const,
    path: relativePath,
    digest: yield* digestBytes(bytes, relativePath),
  }
})

// Resolves the default target: uncommitted changes vs HEAD, diff frozen at
// submission (ADR 0005 — explicit aiming, the working tree is the
// zero-thought default). Untracked files are outside the diff; they surface
// as a scope-degradation warning on the target, never silently. Included
// untracked files also carry a content digest so resume can detect content
// drift without persisting the bytes.
export const resolveWorkingTreeTarget = Effect.fn(
  "gauntlet.working_tree.resolve_working_tree_target",
)(function* (directory: string) {
  const repoRoot = yield* runGit(directory, ["rev-parse", "--show-toplevel"]).pipe(
    explainGit("not inside a git repository"),
    Effect.map(chompLine),
  )
  const headCommit = yield* runGit(repoRoot, ["rev-parse", "HEAD"]).pipe(
    explainGit("repository has no HEAD commit to diff against"),
    Effect.map(chompLine),
  )
  // Diff against the resolved hash, not symbolic HEAD — a commit landing
  // between the two commands must not desynchronize identity and diff.
  const [diff, changedFiles, untracked] = yield* Effect.all(
    [
      runGit(repoRoot, ["diff", headCommit]).pipe(
        explainGit("could not diff the working tree against HEAD"),
      ),
      runGit(repoRoot, ["diff", "--name-only", "-z", headCommit]).pipe(
        explainGit("could not list changed files"),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
      runGit(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]).pipe(
        explainGit("could not list untracked files"),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
    ],
    { concurrency: 2 },
  )

  if (diff === "") {
    return yield* new TargetUnresolvable({
      reason: untracked.length === 0
        ? "working tree has no uncommitted changes to review"
        : `working tree has no uncommitted changes to review (${untracked.length} untracked file(s) are not part of the diff)`,
      cause: undefined,
    })
  }

  const inspections = yield* Effect.forEach(
    untracked,
    (relativePath) => inspectUntrackedFile(repoRoot, relativePath),
    { concurrency: 4 },
  )
  const untrackedFiles = inspections.flatMap((file) =>
    file.kind === "included"
      ? [{ path: file.path, digest: file.digest }]
      : []
  )
  const named = inspections.flatMap((file) =>
    file.kind === "oversized" ? [] : [file.path]
  )
  const oversized = inspections.flatMap((file) =>
    file.kind === "oversized" ? [file.path] : []
  )

  const warnings = [
    ...(named.length === 0 ? [] : [
      `${named.length} untracked file(s) not included in the diff: ${named.join(", ")}`,
    ]),
    ...(oversized.length === 0 ? [] : [
      `${oversized.length} untracked file(s) exceed 10MB and are excluded from the review: ${
        oversized.join(", ")
      }`,
    ]),
  ]

  return ReviewTarget.cases.WorkingTree.make({
    repoRoot,
    headCommit,
    changedFiles,
    diff,
    untrackedFiles,
    warnings,
  })
})
