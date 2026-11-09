import { assert, describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as TestConsole from "effect/testing/TestConsole"
import { ReviewTarget } from "../domain/review-target.ts"
import { chompLine, runGit } from "../target/git.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { type RunMilestone, RunMilestones } from "./run-milestones.ts"
import {
  acquireReviewWorkingDirectory,
  captureWorkspaceOverlay,
} from "./review-working-directory.ts"

const RUN_ID = "review-working-directory-test"

// A PR target never consults the overlay, so its path is deliberately absent.
const NO_OVERLAY = "/nonexistent/workspace-overlay.patch"

const freezeOverlay = Effect.fn("test.freeze_overlay")(function* (
  target: Extract<ReviewTarget, { readonly _tag: "WorkingTree" }>,
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const overlayPath = path.join(directory, "workspace-overlay.patch")
  const overlay = yield* Effect.scoped(captureWorkspaceOverlay(target))
  yield* fs.writeFile(
    overlayPath,
    overlay,
  )
  return overlayPath
})

const worktreeCount = (porcelain: string): number =>
  Array.filter(porcelain.split("\n"), (line) => line.startsWith("worktree ")).length

const countWorktrees = (repo: string) =>
  runGit(repo, ["worktree", "list", "--porcelain"]).pipe(
    Effect.map(worktreeCount),
  )

const makeMismatchedPullRequestTarget = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { repo } = yield* makeGitFixture({
    prefix: "gauntlet-pr-worktree-test-",
  })
  const file = path.join(repo, "alpha.txt")
  yield* fs.writeFileString(file, "base\n")
  yield* commitAll(repo, "base")
  const baseCommit = yield* runGit(repo, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))

  yield* fs.writeFileString(file, "frozen head\n")
  yield* commitAll(repo, "head")
  const headCommit = yield* runGit(repo, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))

  // The caller is deliberately on the wrong commit with an unrelated dirty
  // file. Agent tools must see neither piece of live-checkout state.
  yield* runGit(repo, ["checkout", "--detach", baseCommit])
  yield* fs.writeFileString(path.join(repo, "caller-only.txt"), "dirty\n")

  return {
    repo,
    target: ReviewTarget.cases.PullRequest.make({
      repoRoot: repo,
      number: 47,
      headCommit,
      baseCommit,
      changedFiles: ["alpha.txt"],
      diff: "fixture diff",
      warnings: [],
    }),
  }
})

describe("PR review working directory", () => {
  it.effect("points tools at the frozen head and cleans up after success", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { repo, target } = yield* makeMismatchedPullRequestTarget
      let reviewDirectory = ""
      const reported: Array<RunMilestone> = []

      yield* Effect.scoped(
        Effect.gen(function* () {
          reviewDirectory = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY).pipe(
            Effect.provideService(RunMilestones, (milestone) =>
              Effect.sync(() => {
                reported.push(milestone)
              })),
          )
          expect(reviewDirectory).not.toBe(repo)
          const reviewedHead = yield* runGit(reviewDirectory, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))
          expect(reviewedHead).toBe(target.headCommit)
          const reviewedAlpha = yield* fs.readFileString(path.join(reviewDirectory, "alpha.txt"))
          expect(reviewedAlpha).toBe("frozen head\n")
          const callerOnlyExists = yield* fs.exists(path.join(reviewDirectory, "caller-only.txt"))
          expect(callerOnlyExists).toBe(false)
          const worktreesDuring = yield* countWorktrees(repo)
          expect(worktreesDuring).toBe(2)
        }),
      )

      const reviewDirectoryExists = yield* fs.exists(reviewDirectory)
      expect(reviewDirectoryExists).toBe(false)
      const worktreesAfter = yield* countWorktrees(repo)
      expect(worktreesAfter).toBe(1)
      // A Host that loses the Run removes the one directory reported, which
      // holds the snapshot; the Run removed it as it ended.
      const directories = Array.flatMap(reported, (milestone) =>
        milestone._tag === "SnapshotDirectoryMade" ? [milestone.directory] : [])
      assert(Predicate.isTupleOf(directories, 1), `expected one reported directory, got ${directories.length}`)
      const [made] = directories
      expect(reviewDirectory.startsWith(`${made}${path.sep}`)).toBe(true)
      const madeExists = yield* fs.exists(made)
      expect(madeExists).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("cleans up after a typed failure", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { repo, target } = yield* makeMismatchedPullRequestTarget
      let reviewDirectory = ""

      const reason = yield* Effect.scoped(
        Effect.gen(function* () {
          reviewDirectory = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY)
          return yield* Effect.fail("fixture failure")
        }),
      ).pipe(Effect.flip)

      expect(reason).toBe("fixture failure")
      const reviewDirectoryExists = yield* fs.exists(reviewDirectory)
      expect(reviewDirectoryExists).toBe(false)
      const worktreesAfter = yield* countWorktrees(repo)
      expect(worktreesAfter).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("warns, without failing the scope, when the worktree cannot be removed", () =>
    Effect.gen(function* () {
      const { repo, target } = yield* makeMismatchedPullRequestTarget

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY)
          // Removed behind the release's back, so its own removal fails.
          yield* runGit(repo, ["worktree", "remove", "--force", directory])
          return "reviewed"
        }),
      )

      expect(result).toBe("reviewed")
      const errorLines = yield* TestConsole.errorLines
      expect(Array.join(Array.map(errorLines, String), "\n")).toContain(
        "gauntlet: warning — could not remove the review worktree",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("cleans up when the Run is interrupted", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const { repo, target } = yield* makeMismatchedPullRequestTarget
      const ready = yield* Deferred.make<string>()
      const fiber = yield* Effect.scoped(
        Effect.gen(function* () {
          const directory = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY)
          yield* Deferred.succeed(ready, directory)
          return yield* Effect.never
        }),
      ).pipe(Effect.forkChild)

      const reviewDirectory = yield* Deferred.await(ready)
      const existsWhileRunning = yield* fs.exists(reviewDirectory)
      expect(existsWhileRunning).toBe(true)
      const worktreesWhileRunning = yield* countWorktrees(repo)
      expect(worktreesWhileRunning).toBe(2)
      yield* Fiber.interrupt(fiber)
      const existsAfterInterrupt = yield* fs.exists(reviewDirectory)
      expect(existsAfterInterrupt).toBe(false)
      const worktreesAfterInterrupt = yield* countWorktrees(repo)
      expect(worktreesAfterInterrupt).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("working-tree review working directory", () => {
  it.effect("materializes the frozen working-tree changes, unpinned from the live checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { repo, root } = yield* makeGitFixture({
        prefix: "gauntlet-working-tree-snapshot-test-",
      })
      const inRepo = (name: string) => path.join(repo, name)
      yield* fs.writeFileString(inRepo("alpha.txt"), "base\n")
      yield* fs.writeFileString(inRepo("delete-me.txt"), "obsolete\n")
      yield* fs.writeFileString(inRepo("old-name.txt"), "renamed content\n")
      yield* fs.writeFile(inRepo("bin.dat"), new Uint8Array([0, 1, 2, 3]))
      yield* fs.writeFileString(inRepo("script.sh"), "#!/bin/sh\n")
      yield* fs.symlink("alpha.txt", inRepo("linky"))
      yield* fs.writeFileString(inRepo("reshaped"), "was a file\n")
      yield* fs.writeFileString(inRepo(".gitignore"), "ignored.txt\n")
      yield* commitAll(repo, "base")

      // Every Git-visible operation the snapshot must reproduce: content
      // edit, deletion, staged rename, binary change, mode flip, repointed
      // symlink, staged addition — plus untracked file and symlink, with an
      // ignored file that must stay out.
      yield* fs.writeFileString(inRepo("alpha.txt"), "base\nmodified\n")
      yield* fs.remove(inRepo("delete-me.txt"))
      yield* runGit(repo, ["mv", "old-name.txt", "new-name.txt"])
      yield* fs.writeFile(inRepo("bin.dat"), new Uint8Array([9, 8, 7, 0]))
      yield* fs.chmod(inRepo("script.sh"), 0o755)
      yield* fs.remove(inRepo("linky"))
      yield* fs.symlink("bin.dat", inRepo("linky"))
      yield* fs.writeFileString(inRepo("staged.txt"), "staged addition\n")
      yield* runGit(repo, ["add", "staged.txt"])
      yield* fs.writeFileString(inRepo("stray.txt"), "untracked payload\n")
      // Bracketed name: must be staged literally, not as pathspec magic.
      yield* fs.writeFileString(inRepo("notes[1].txt"), "bracketed\n")
      yield* fs.symlink("alpha.txt", inRepo("stray-link"))
      yield* fs.writeFileString(inRepo("ignored.txt"), "invisible\n")
      // Tracked file replaced by a plain directory holding untracked files.
      yield* fs.remove(inRepo("reshaped"))
      yield* fs.makeDirectory(inRepo("reshaped"))
      yield* fs.writeFileString(inRepo("reshaped/child.txt"), "dir child\n")

      const target = yield* resolveWorkingTreeTarget(repo, undefined)
      expect(ReviewTarget.guards.WorkingTree(target)).toBe(true)
      expect(target.changedFiles).toContain("old-name.txt")
      expect(target.changedFiles).toContain("new-name.txt")
      const overlay = yield* freezeOverlay(target, root)
      let snapshot = ""

      yield* Effect.scoped(
        Effect.gen(function* () {
          snapshot = yield* acquireReviewWorkingDirectory(target, RUN_ID, overlay)
          const inSnapshot = (name: string) => path.join(snapshot, name)
          expect(snapshot).not.toBe(repo)
          const snapshotHead = yield* runGit(snapshot, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))
          expect(snapshotHead).toBe(target.headCommit)

          const alpha = yield* fs.readFileString(inSnapshot("alpha.txt"))
          expect(alpha).toBe("base\nmodified\n")
          const deleteMeExists = yield* fs.exists(inSnapshot("delete-me.txt"))
          expect(deleteMeExists).toBe(false)
          const oldNameExists = yield* fs.exists(inSnapshot("old-name.txt"))
          expect(oldNameExists).toBe(false)
          const renamed = yield* fs.readFileString(inSnapshot("new-name.txt"))
          expect(renamed).toBe("renamed content\n")
          const snapshotBytes = yield* fs.readFile(inSnapshot("bin.dat"))
          expect(Array.fromIterable(snapshotBytes)).toEqual(
            [9, 8, 7, 0],
          )
          const script = yield* fs.stat(inSnapshot("script.sh"))
          expect(script.mode & 0o111).not.toBe(0)
          const linkyTarget = yield* fs.readLink(inSnapshot("linky"))
          expect(linkyTarget).toBe("bin.dat")
          const staged = yield* fs.readFileString(inSnapshot("staged.txt"))
          expect(staged).toBe("staged addition\n")
          const stray = yield* fs.readFileString(inSnapshot("stray.txt"))
          expect(stray).toBe("untracked payload\n")
          const strayLinkTarget = yield* fs.readLink(inSnapshot("stray-link"))
          expect(strayLinkTarget).toBe("alpha.txt")
          const bracketed = yield* fs.readFileString(inSnapshot("notes[1].txt"))
          expect(bracketed).toBe("bracketed\n")
          const ignoredExists = yield* fs.exists(inSnapshot("ignored.txt"))
          expect(ignoredExists).toBe(false)
          expect((yield* fs.stat(inSnapshot("reshaped"))).type).toBe(
            "Directory",
          )
          const directoryChild = yield* fs.readFileString(inSnapshot("reshaped/child.txt"))
          expect(directoryChild).toBe("dir child\n")

          // Edits and new commits in the developer's repo after acquisition
          // are invisible to the Run already in flight.
          yield* fs.writeFileString(inRepo("alpha.txt"), "live edit\n")
          yield* fs.writeFileString(inRepo("stray.txt"), "live stray edit\n")
          yield* commitAll(repo, "live drift")
          const alphaAfterDrift = yield* fs.readFileString(inSnapshot("alpha.txt"))
          expect(alphaAfterDrift).toBe("base\nmodified\n")
          const strayAfterDrift = yield* fs.readFileString(inSnapshot("stray.txt"))
          expect(strayAfterDrift).toBe("untracked payload\n")
          const headAfterDrift = yield* runGit(snapshot, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))
          expect(headAfterDrift).toBe(target.headCommit)
          const worktreesDuring = yield* countWorktrees(repo)
          expect(worktreesDuring).toBe(2)
        }),
      )

      const snapshotExists = yield* fs.exists(snapshot)
      expect(snapshotExists).toBe(false)
      const worktreesAfter = yield* countWorktrees(repo)
      expect(worktreesAfter).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("shows a submodule as an unpopulated gitlink behind a scope-degradation warning", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { repo, root } = yield* makeGitFixture({
        prefix: "gauntlet-submodule-snapshot-test-",
      })
      const inner = path.join(root, "inner")
      yield* fs.makeDirectory(inner)
      yield* runGit(inner, ["init"])
      yield* fs.writeFileString(path.join(inner, "inner.txt"), "inner\n")
      yield* commitAll(inner, "inner base")

      yield* fs.writeFileString(path.join(repo, "alpha.txt"), "base\n")
      yield* commitAll(repo, "base")
      yield* runGit(repo, [
        "-c",
        "protocol.file.allow=always",
        "submodule",
        "add",
        inner,
        "sub",
      ])
      yield* commitAll(repo, "add submodule")
      yield* fs.writeFileString(path.join(repo, "alpha.txt"), "base\nchanged\n")

      const target = yield* resolveWorkingTreeTarget(repo, undefined)
      expect(target.warnings).toContain(
        "1 submodule(s) whose contents are not included in the review: sub",
      )
      const overlay = yield* freezeOverlay(target, root)

      yield* Effect.scoped(
        Effect.gen(function* () {
          const snapshot = yield* acquireReviewWorkingDirectory(target, RUN_ID, overlay)
          const gitlink = yield* fs.stat(path.join(snapshot, "sub"))
          expect(gitlink.type).toBe("Directory")
          // The live checkout has populated contents; the snapshot must not.
          const innerExists = yield* fs.exists(path.join(repo, "sub", "inner.txt"))
          expect(innerExists).toBe(true)
          const snapshotSubEntries = yield* fs.readDirectory(path.join(snapshot, "sub"))
          expect(snapshotSubEntries).toEqual([])
        }),
      )
      const worktreesAfter = yield* countWorktrees(repo)
      expect(worktreesAfter).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
