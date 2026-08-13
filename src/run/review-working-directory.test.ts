import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { ReviewTarget } from "../domain/review-target.ts"
import { chompLine, runGit } from "../target/git.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { acquireReviewWorkingDirectory } from "./review-working-directory.ts"
import { RunError } from "./run-record.ts"

const RUN_ID = "review-working-directory-test"

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
          reviewDirectory = yield* acquireReviewWorkingDirectory(target, RUN_ID)
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
          reviewDirectory = yield* acquireReviewWorkingDirectory(target, RUN_ID)
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
          const directory = yield* acquireReviewWorkingDirectory(target, RUN_ID)
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
