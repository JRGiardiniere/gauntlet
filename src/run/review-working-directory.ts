import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type { ReviewTarget } from "../domain/review-target.ts"
import { describeGitFailure, runGit } from "../target/git.ts"
import { RunError } from "./run-record.ts"

// Filesystem-facing agent tools must observe the frozen ReviewTarget. A
// WorkingTree target already names the live checkout whose consistency is
// checked before spend; a PullRequest target gets a detached, run-scoped
// worktree at its frozen head commit (#47).
export const acquireReviewWorkingDirectory = Effect.fn(
  "gauntlet.review_working_directory.acquire",
)(function* (target: ReviewTarget, runId: string) {
  if (target._tag === "WorkingTree") return target.repoRoot

  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scratchDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "gauntlet-pr-review-",
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
            `could not create review worktree for PR #${String(target.number)}`,
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
  return directory
})
