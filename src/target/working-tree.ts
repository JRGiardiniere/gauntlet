import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  chompLine,
  explainGit,
  gitlinkPaths,
  mergeBaseOf,
  resolveCommittish,
  runGit,
  submoduleWarning,
  TargetUnresolvable,
} from "./git.ts"

const explainUntrackedFile = (reason: string) =>
<A, R>(
  self: Effect.Effect<A, { readonly _tag: "PlatformError" }, R>,
): Effect.Effect<A, TargetUnresolvable, R> =>
  Effect.catchTag(self, "PlatformError", (cause) =>
    Effect.fail(new TargetUnresolvable({ reason, cause })))

// Git already governs tracked files. Untracked files larger than this are
// dropped from the included set and named in a scope-degradation warning.
const UNTRACKED_SIZE_CAP = FileSystem.MiB(10)

const inspectUntrackedFile = Effect.fn(
  "gauntlet.working_tree.inspect_untracked_file",
)(function* (repoRoot: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const absolutePath = path.join(repoRoot, relativePath)
  // stat follows symlinks; readLink first so a dangling or directory-target
  // link is included as itself instead of aborting resolution.
  const linkTarget = yield* fs.readLink(absolutePath).pipe(Effect.option)
  if (Option.isSome(linkTarget)) {
    return { kind: "included" as const, path: relativePath }
  }
  const info = yield* fs.stat(absolutePath).pipe(
    explainUntrackedFile(`could not inspect untracked file ${relativePath}`),
  )
  if (info.type !== "File") {
    return { kind: "named" as const, path: relativePath }
  }
  return info.size > UNTRACKED_SIZE_CAP
    ? { kind: "oversized" as const, path: relativePath }
    : { kind: "included" as const, path: relativePath }
})

// Resolves the working-tree target: the review diff ends at the working tree
// as submitted, frozen there (ADR 0005). `--working-tree` alone starts that
// diff at HEAD; the combined `--commits <base> --working-tree` form starts it
// at merge-base(base, HEAD), so one target serves both — the persisted overlay
// stays relative to headCommit either way. Untracked files are outside the
// diff; they surface as a scope-degradation warning, never silently.
export const resolveWorkingTreeTarget = Effect.fn(
  "gauntlet.working_tree.resolve_working_tree_target",
)(function* (directory: string, base: string | undefined) {
  const repoRoot = yield* runGit(directory, ["rev-parse", "--show-toplevel"]).pipe(
    explainGit("not inside a git repository"),
    Effect.map(chompLine),
  )
  const headCommit = yield* runGit(repoRoot, ["rev-parse", "HEAD"]).pipe(
    explainGit("repository has no HEAD commit to diff against"),
    Effect.map(chompLine),
  )
  const baseCommit = base === undefined ? undefined : yield* mergeBaseOf(
    repoRoot,
    yield* resolveCommittish(repoRoot, base),
    headCommit,
  )
  const diffBase = baseCommit ?? headCommit
  // Diff against the resolved hash, not symbolic HEAD — a commit landing
  // between the two commands must not desynchronize identity and diff.
  // --no-renames keeps both sides of a rename in changedFiles (the snapshot
  // must delete the old path) and makes the list independent of diff.renames.
  const [diff, changedFiles, untracked, submodules] = yield* Effect.all(
    [
      runGit(repoRoot, ["diff", diffBase]).pipe(
        explainGit("could not diff the working tree"),
      ),
      runGit(repoRoot, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        diffBase,
      ]).pipe(
        explainGit("could not list changed files"),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
      runGit(repoRoot, ["ls-files", "-z", "--others", "--exclude-standard"]).pipe(
        explainGit("could not list untracked files"),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
      runGit(repoRoot, ["ls-files", "-z", "--stage"]).pipe(
        explainGit("could not list tracked files"),
        Effect.map(gitlinkPaths),
      ),
    ],
    { concurrency: 2 },
  )

  if (diff === "") {
    const nothing = base === undefined
      ? "working tree has no uncommitted changes to review"
      : `${base} has no committed or uncommitted changes to review`
    return yield* new TargetUnresolvable({
      reason: untracked.length === 0
        ? nothing
        : `${nothing} (${untracked.length} untracked file(s) are not part of the diff)`,
      cause: undefined,
    })
  }

  const inspections = yield* Effect.forEach(
    untracked,
    (relativePath) => inspectUntrackedFile(repoRoot, relativePath),
    { concurrency: 4 },
  )
  const untrackedFiles = inspections.flatMap((file) =>
    file.kind === "included" ? [file.path] : []
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
    ...submoduleWarning(submodules),
  ]

  const fields = {
    repoRoot,
    headCommit,
    changedFiles,
    diff,
    untrackedFiles,
    warnings,
  }
  return ReviewTarget.cases.WorkingTree.make(
    baseCommit === undefined ? fields : { ...fields, baseCommit },
  )
})
