import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  describeGitFailure,
  explainGit,
  runGit,
  TargetUnresolvable,
} from "../target/git.ts"
import { reportMilestone, RunMilestone } from "./run-milestones.ts"
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
  // The overlay is relative to headCommit, so it stages the files that differ
  // from headCommit — not target.changedFiles, which starts at the review
  // diff's base and, in the combined commits-plus-working-tree form, names
  // paths the head commit no longer has. Read through the real index so a
  // staged addition counts as changed, exactly as target resolution saw it.
  const changedFiles = yield* runGit(target.repoRoot, [
    "diff",
    "--name-only",
    "--no-renames",
    "-z",
    target.headCommit,
  ]).pipe(
    explainGit("could not list the files to capture in the overlay"),
    Effect.map((out) => out.split("\0").filter((line) => line !== "")),
  )
  yield* git(["read-tree", target.headCommit])
  // :(literal) keeps bracketed or colon-prefixed filenames from being read
  // as pathspec magic. An empty pathspec would mean "everything", so a clean
  // tree under a commit range captures an empty overlay instead.
  const staged = [...changedFiles, ...target.untrackedFiles]
  if (staged.length > 0) {
    yield* git([
      "add",
      "-A",
      "--",
      ...staged.map((file) => `:(literal)${file}`),
    ])
  }
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
  const label = ReviewTarget.match(target, {
    WorkingTree: () => "the working tree",
    Commits: ({ headCommit }) => `commit ${headCommit}`,
    PullRequest: ({ number }) => `PR #${String(number)}`,
  })
  const runFailure = (reason: string, cause?: unknown) =>
    new RunError({ operation: "execute-plan", reason, runId, cause })
  const scratchDirectory = yield* fs.makeTempDirectoryScoped({
    prefix: "gauntlet-review-",
  })
  yield* reportMilestone(RunMilestone.SnapshotDirectoryMade({ directory: scratchDirectory }))
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
    // The release runs after the Dossier is written: a worktree left behind
    // is a warning, never a review that failed.
    () =>
      runGit(target.repoRoot, [
        "worktree",
        "remove",
        "--force",
        directory,
      ]).pipe(
        Effect.catchTag("GitCommandError", (cause) =>
          Console.error(
            `gauntlet: warning — ${
              describeGitFailure(
                `could not remove the review worktree ${directory}`,
                cause,
              )
            }; run \`git worktree prune\` in ${target.repoRoot} to clear it`,
          )),
      ),
  )
  if (target._tag !== "WorkingTree") return directory
  yield* runGit(directory, [
    "apply",
    "--binary",
    // A commit range plus a clean working tree captures an empty overlay.
    "--allow-empty",
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
