import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ReviewTarget } from "../domain/review-target.ts"
import { chompLine, runGit } from "../target/git.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import {
  acquireReviewWorkingDirectory,
  captureWorkspaceOverlay,
} from "./review-working-directory.ts"
import { RunError } from "./run-record.ts"

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
  yield* fs.writeFile(
    overlayPath,
    yield* Effect.scoped(captureWorkspaceOverlay(target)),
  )
  return overlayPath
})

const worktreeCount = (porcelain: string): number =>
  porcelain.split("\n").filter((line) => line.startsWith("worktree ")).length

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
  const baseCommit = chompLine(yield* runGit(repo, ["rev-parse", "HEAD"]))

  yield* fs.writeFileString(file, "frozen head\n")
  yield* commitAll(repo, "head")
  const headCommit = chompLine(yield* runGit(repo, ["rev-parse", "HEAD"]))

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

      yield* Effect.scoped(
        Effect.gen(function* () {
          reviewDirectory = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY)
          expect(reviewDirectory).not.toBe(repo)
          expect(
            chompLine(yield* runGit(reviewDirectory, ["rev-parse", "HEAD"])),
          ).toBe(target.headCommit)
          expect(
            yield* fs.readFileString(path.join(reviewDirectory, "alpha.txt")),
          ).toBe("frozen head\n")
          expect(
            yield* fs.exists(path.join(reviewDirectory, "caller-only.txt")),
          ).toBe(false)
          expect(yield* countWorktrees(repo)).toBe(2)
        }),
      )

      expect(yield* fs.exists(reviewDirectory)).toBe(false)
      expect(yield* countWorktrees(repo)).toBe(1)
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
      expect(yield* fs.exists(reviewDirectory)).toBe(false)
      expect(yield* countWorktrees(repo)).toBe(1)
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
      expect(yield* fs.exists(reviewDirectory)).toBe(true)
      expect(yield* countWorktrees(repo)).toBe(2)
      yield* Fiber.interrupt(fiber)
      expect(yield* fs.exists(reviewDirectory)).toBe(false)
      expect(yield* countWorktrees(repo)).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reports worktree creation failures with Git's reason", () =>
    Effect.gen(function* () {
      const { target } = yield* makeMismatchedPullRequestTarget
      const missingCommit = "0000000000000000000000000000000000000000"
      const missingTarget = ReviewTarget.cases.PullRequest.make({
        ...target,
        headCommit: missingCommit,
      })

      const failure = yield* acquireReviewWorkingDirectory(
        missingTarget,
        RUN_ID,
        NO_OVERLAY,
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(RunError)
      if (failure._tag !== "RunError") return
      expect(failure.operation).toBe("execute-plan")
      expect(failure.runId).toBe(RUN_ID)
      expect(failure.reason).toContain(
        `could not create review worktree for PR #${String(target.number)}`,
      )
      expect(failure.reason).toContain(missingCommit)
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
      yield* fs.symlink("alpha.txt", inRepo("stray-link"))
      yield* fs.writeFileString(inRepo("ignored.txt"), "invisible\n")
      // Tracked file replaced by a plain directory holding untracked files.
      yield* fs.remove(inRepo("reshaped"))
      yield* fs.makeDirectory(inRepo("reshaped"))
      yield* fs.writeFileString(inRepo("reshaped/child.txt"), "dir child\n")

      const target = yield* resolveWorkingTreeTarget(repo)
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
          expect(
            chompLine(yield* runGit(snapshot, ["rev-parse", "HEAD"])),
          ).toBe(target.headCommit)

          expect(yield* fs.readFileString(inSnapshot("alpha.txt"))).toBe(
            "base\nmodified\n",
          )
          expect(yield* fs.exists(inSnapshot("delete-me.txt"))).toBe(false)
          expect(yield* fs.exists(inSnapshot("old-name.txt"))).toBe(false)
          expect(yield* fs.readFileString(inSnapshot("new-name.txt"))).toBe(
            "renamed content\n",
          )
          expect(Array.from(yield* fs.readFile(inSnapshot("bin.dat")))).toEqual(
            [9, 8, 7, 0],
          )
          const script = yield* fs.stat(inSnapshot("script.sh"))
          expect(script.mode & 0o111).not.toBe(0)
          expect(yield* fs.readLink(inSnapshot("linky"))).toBe("bin.dat")
          expect(yield* fs.readFileString(inSnapshot("staged.txt"))).toBe(
            "staged addition\n",
          )
          expect(yield* fs.readFileString(inSnapshot("stray.txt"))).toBe(
            "untracked payload\n",
          )
          expect(yield* fs.readLink(inSnapshot("stray-link"))).toBe("alpha.txt")
          expect(yield* fs.exists(inSnapshot("ignored.txt"))).toBe(false)
          expect((yield* fs.stat(inSnapshot("reshaped"))).type).toBe(
            "Directory",
          )
          expect(
            yield* fs.readFileString(inSnapshot("reshaped/child.txt")),
          ).toBe("dir child\n")

          // Edits and new commits in the developer's repo after acquisition
          // are invisible to the Run already in flight.
          yield* fs.writeFileString(inRepo("alpha.txt"), "live edit\n")
          yield* fs.writeFileString(inRepo("stray.txt"), "live stray edit\n")
          yield* commitAll(repo, "live drift")
          expect(yield* fs.readFileString(inSnapshot("alpha.txt"))).toBe(
            "base\nmodified\n",
          )
          expect(yield* fs.readFileString(inSnapshot("stray.txt"))).toBe(
            "untracked payload\n",
          )
          expect(
            chompLine(yield* runGit(snapshot, ["rev-parse", "HEAD"])),
          ).toBe(target.headCommit)
          expect(yield* countWorktrees(repo)).toBe(2)
        }),
      )

      expect(yield* fs.exists(snapshot)).toBe(false)
      expect(yield* countWorktrees(repo)).toBe(1)
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

      const target = yield* resolveWorkingTreeTarget(repo)
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
          expect(
            yield* fs.exists(path.join(repo, "sub", "inner.txt")),
          ).toBe(true)
          expect(yield* fs.readDirectory(path.join(snapshot, "sub"))).toEqual(
            [],
          )
        }),
      )
      expect(yield* countWorktrees(repo)).toBe(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
