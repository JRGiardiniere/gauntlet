import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import type { ReviewTarget } from "../domain/review-target.ts"
import { describeGitFailure, runGit } from "../target/git.ts"
import { TargetUnresolvable } from "../target/working-tree.ts"
import { RunError } from "./run-record.ts"

type WorkingTreeTarget = Extract<ReviewTarget, { readonly _tag: "WorkingTree" }>

// Filesystem-facing agent tools observe the Run's frozen inputs, never the
// developer's live checkout: a detached worktree at the frozen head commit,
// plus — for a WorkingTree target — the overlay persisted in the run
// directory. Git already retains every committed byte under the head commit,
// so the overlay carries only what it cannot: the uncommitted state at
// submission. Submodule contents are never materialized — the gitlink stays
// an unpopulated directory, under the target's scope-degradation warning.

// Staging into a scratch index puts tracked edits and the included untracked
// files in one patch, so reconstruction is a single `git apply`.
export const captureWorkspaceOverlay = Effect.fn(
  "gauntlet.review_working_directory.capture_overlay",
)(function* (target: WorkingTreeTarget) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const scratch = yield* fs.makeTempDirectoryScoped({
    prefix: "gauntlet-overlay-",
  })
  const overlay = path.join(scratch, "overlay.patch")
  const git = (args: ReadonlyArray<string>) =>
    runGit(target.repoRoot, args, {
      GIT_INDEX_FILE: path.join(scratch, "index"),
    }).pipe(
      Effect.mapError((cause) =>
        new TargetUnresolvable({
          reason: describeGitFailure(
            "could not capture the working-tree overlay",
            cause,
          ),
          cause,
        })
      ),
    )
  yield* git(["read-tree", target.headCommit])
  yield* git([
    "add",
    "-A",
    "--",
    ...target.changedFiles,
    ...target.untrackedFiles,
  ])
  yield* git([
    "diff",
    "--binary",
    "--no-renames",
    "--cached",
    `--output=${overlay}`,
    target.headCommit,
  ])
  return yield* fs.readFile(overlay).pipe(
    Effect.mapError((cause) =>
      new TargetUnresolvable({
        reason: "could not read the captured working-tree overlay",
        cause,
      })
    ),
  )
})

export const acquireReviewWorkingDirectory = Effect.fn(
  "gauntlet.review_working_directory.acquire",
)(function* (target: ReviewTarget, runId: string, overlayPath: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const label = target._tag === "WorkingTree"
    ? "the working tree"
    : `PR #${String(target.number)}`
  const runFailure = (reason: string, cause?: unknown) =>
    new RunError({ operation: "execute-plan", reason, runId, cause })
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
        runFailure(
          describeGitFailure(
            `could not create review worktree for ${label}`,
            cause,
          ),
          cause,
        )
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
  if (target._tag !== "WorkingTree") return directory
  const present = yield* fs.exists(overlayPath).pipe(
    Effect.mapError((cause) =>
      runFailure(`could not inspect ${overlayPath}`, cause)
    ),
  )
  if (!present) {
    return yield* runFailure(
      `the frozen working-tree overlay ${overlayPath} is missing`,
    )
  }
  yield* runGit(directory, [
    "apply",
    "--binary",
    "--whitespace=nowarn",
    overlayPath,
  ]).pipe(
    Effect.mapError((cause) =>
      runFailure(
        describeGitFailure(
          `could not apply the frozen working-tree overlay ${overlayPath}`,
          cause,
        ),
        cause,
      )
    ),
  )
  return directory
})
