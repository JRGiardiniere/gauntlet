import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { GitHubError, gitHubLayer, type PullRequestView } from "../github/github.ts"
import { chompLine, runGit } from "./git.ts"
import { resolvePullRequestTarget } from "./pull-request.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { TargetUnresolvable } from "./working-tree.ts"

const viewOf = (
  number: number,
  headRefOid: string,
  baseRefOid: string,
): PullRequestView => ({
  number,
  headRefOid,
  baseRefOid,
  baseRefName: "main",
  url: `https://github.com/example/repo/pull/${String(number)}`,
})

const makePrRepo = Effect.gen(function* () {
  const { repo } = yield* makeGitFixture({ prefix: "gauntlet-pr-target-" })
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.writeFileString(path.join(repo, "alpha.txt"), "first line\n")
  yield* commitAll(repo, "base")
  const baseCommit = chompLine(yield* runGit(repo, ["rev-parse", "HEAD"]))
  yield* fs.writeFileString(
    path.join(repo, "alpha.txt"),
    "first line\npr-added-line\n",
  )
  yield* commitAll(repo, "head")
  const headCommit = chompLine(yield* runGit(repo, ["rev-parse", "HEAD"]))
  yield* fs.writeFileString(
    path.join(repo, "alpha.txt"),
    "first line\npr-added-line\nuncommitted-line\n",
  )
  return { repo, baseCommit, headCommit }
})

describe("resolvePullRequestTarget", () => {
  it.effect("freezes the PR range from GitHub OIDs, never the dirty working tree", () =>
    Effect.gen(function* () {
      const { baseCommit, headCommit, repo } = yield* makePrRepo
      const target = yield* resolvePullRequestTarget(repo, 7).pipe(
        Effect.provide(
          gitHubLayer({
            viewPullRequest: () =>
              Effect.succeed(viewOf(7, headCommit, baseCommit)),
            postComment: () =>
              Effect.fail(
                new GitHubError({ operation: "post", reason: "unused" }),
              ),
          }),
        ),
      )

      expect(target._tag).toBe("PullRequest")
      expect(target.number).toBe(7)
      expect(target.headCommit).toBe(headCommit)
      expect(target.baseCommit).toBe(baseCommit)
      expect(target.changedFiles).toEqual(["alpha.txt"])
      expect(target.diff).toContain("+pr-added-line")
      expect(target.diff).not.toContain("uncommitted-line")
      expect(target.warnings).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("does not fall back to the working tree when the PR range is empty", () =>
    Effect.gen(function* () {
      const { headCommit, repo } = yield* makePrRepo
      const failed = yield* resolvePullRequestTarget(repo, 7).pipe(
        Effect.provide(
          gitHubLayer({
            viewPullRequest: () =>
              Effect.succeed(viewOf(7, headCommit, headCommit)),
            postComment: () =>
              Effect.fail(
                new GitHubError({ operation: "post", reason: "unused" }),
              ),
          }),
        ),
        Effect.flip,
      )

      expect(failed).toBeInstanceOf(TargetUnresolvable)
      expect(failed.reason).toContain("PR #7 has no changes to review")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
