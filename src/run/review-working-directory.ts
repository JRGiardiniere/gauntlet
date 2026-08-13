import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import type { ReviewTarget } from "../domain/review-target.ts"
import { describeGitFailure, runGit } from "../target/git.ts"
import { RunError } from "./run-record.ts"

// Filesystem-facing agent tools must observe the frozen ReviewTarget, never
// the developer's live checkout. Both target kinds get one detached,
// run-scoped worktree at the frozen head commit, shared by every invocation
// in the Run (#47, #56). A WorkingTree target additionally materializes the
// tracked and untracked changes captured at target resolution on top of that
// commit — plain file copies from the checkout, discarded with the Run.
// Submodule contents are never materialized: the gitlink stays an
// unpopulated directory and resolution carries the scope-degradation warning.

// stat follows symlinks; readLink first so a repository-contained symlink is
// reproduced as a link to the same target, dangling or not.
const syncPathFromCheckout = Effect.fn(
  "gauntlet.review_working_directory.sync_path",
)(function* (repoRoot: string, snapshotRoot: string, relativePath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const source = path.join(repoRoot, relativePath)
  const destination = path.join(snapshotRoot, relativePath)
  const linkTarget = yield* fs.readLink(source).pipe(Effect.option)
  if (Option.isSome(linkTarget)) {
    yield* fs.remove(destination, { force: true })
    yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
    return yield* fs.symlink(linkTarget.value, destination)
  }
  if (!(yield* fs.exists(source))) {
    // Changed but absent from the checkout: deleted since the frozen HEAD.
    return yield* fs.remove(destination, { force: true })
  }
  const info = yield* fs.stat(source)
  // A changed path that is a directory is either a gitlink bump — the
  // checkout of the head commit already holds the unpopulated directory —
  // or a tracked file replaced by a plain directory, where the stale file
  // must go so the deletion lands and untracked children can be copied
  // beneath it.
  if (info.type !== "File") {
    const destinationInfo = yield* fs.stat(destination).pipe(Effect.option)
    if (
      Option.isSome(destinationInfo) &&
      destinationInfo.value.type !== "Directory"
    ) {
      yield* fs.remove(destination, { force: true })
    }
    return
  }
  yield* fs.remove(destination, { force: true })
  yield* fs.makeDirectory(path.dirname(destination), { recursive: true })
  yield* fs.copyFile(source, destination)
  yield* fs.chmod(destination, info.mode & 0o777)
})

const materializeWorkingTreeChanges = Effect.fn(
  "gauntlet.review_working_directory.materialize",
)(function* (
  target: Extract<ReviewTarget, { readonly _tag: "WorkingTree" }>,
  snapshotRoot: string,
) {
  // A path deleted from the index can reappear as an included untracked
  // file; the Set keeps one sync per path, and syncing from the checkout is
  // idempotent either way. Sequential: a rename's delete and its sibling
  // add may share parent directories.
  const paths = [
    ...new Set([
      ...target.changedFiles,
      ...target.untrackedFiles.map((file) => file.path),
    ]),
  ]
  yield* Effect.forEach(
    paths,
    (relativePath) =>
      syncPathFromCheckout(target.repoRoot, snapshotRoot, relativePath),
    { discard: true },
  )
})

export const acquireReviewWorkingDirectory = Effect.fn(
  "gauntlet.review_working_directory.acquire",
)(function* (target: ReviewTarget, runId: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const label = target._tag === "WorkingTree"
    ? "the working tree"
    : `PR #${String(target.number)}`
  const scratchDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "gauntlet-review-",
  })
  const directory = path.join(scratchDirectory, "worktree")
  yield* Effect.acquireRelease(
    runGit(target.repoRoot, [
      "worktree",
      "add",
      "--detach",
      directory,
      target.headCommit,
    ]).pipe(
      Effect.mapError((cause) =>
        new RunError({
          operation: "execute-plan",
          reason: describeGitFailure(
            `could not create review worktree for ${label}`,
            cause,
          ),
          runId,
          cause,
        })
      ),
    ),
    () =>
      runGit(target.repoRoot, [
        "worktree",
        "remove",
        "--force",
        directory,
      ]).pipe(Effect.orDie),
  )
  if (target._tag === "WorkingTree") {
    yield* materializeWorkingTreeChanges(target, directory).pipe(
      Effect.mapError((cause) =>
        new RunError({
          operation: "execute-plan",
          reason: "could not materialize the working-tree snapshot",
          runId,
          cause,
        })
      ),
    )
  }
  return directory
})
