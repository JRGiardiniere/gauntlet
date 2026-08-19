import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { resolveCommitsTarget } from "./commits.ts"
import { chompLine, runGit } from "./git.ts"
import { resolveWorkingTreeTarget } from "./working-tree.ts"

// A trunk commit, a `feature` branch with one commit on top, then one more
// commit on trunk — so merge-base semantics are observable and the range is
// not the same as the diff against trunk's tip.
const makeBranchedRepo = Effect.gen(function* () {
  const { repo } = yield* makeGitFixture({ prefix: "gauntlet-commits-" })
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.writeFileString(path.join(repo, "alpha.txt"), "first line\n")
  yield* commitAll(repo, "base")
  const mergeBase = chompLine(yield* runGit(repo, ["rev-parse", "HEAD"]))
  // The fixture repo takes whatever init.defaultBranch is configured.
  const trunk = chompLine(yield* runGit(repo, ["branch", "--show-current"]))
  yield* runGit(repo, ["checkout", "-b", "feature"])
  yield* fs.writeFileString(
    path.join(repo, "alpha.txt"),
    "first line\nfeature-line\n",
  )
  yield* commitAll(repo, "feature work")
  const featureHead = chompLine(yield* runGit(repo, ["rev-parse", "HEAD"]))
  yield* runGit(repo, ["checkout", trunk])
  yield* fs.writeFileString(path.join(repo, "beta.txt"), "unrelated\n")
  yield* commitAll(repo, "unrelated main work")
  yield* runGit(repo, ["checkout", "feature"])
  return { featureHead, mergeBase, repo, trunk }
})

describe("resolveCommitsTarget", () => {
  it.effect("freezes the resolved merge-base and head SHAs, not the refs", () =>
    Effect.gen(function* () {
      const { featureHead, mergeBase, repo, trunk } = yield* makeBranchedRepo

      const target = yield* resolveCommitsTarget(repo, trunk)
      expect(target._tag).toBe("Commits")
      expect(target.baseCommit).toBe(mergeBase)
      expect(target.headCommit).toBe(featureHead)
      // The unrelated main commit is behind the merge-base, so it is not here.
      expect(target.changedFiles).toEqual(["alpha.txt"])
      expect(target.diff).toContain("+feature-line")
      expect(target.diff).not.toContain("unrelated")
      expect(target.warnings).toEqual([])

      const explicit = yield* resolveCommitsTarget(repo, `${trunk}..feature`)
      expect(explicit.baseCommit).toBe(mergeBase)
      expect(explicit.headCommit).toBe(featureHead)

      // Any committish on either end.
      const bySha = yield* resolveCommitsTarget(
        repo,
        `${mergeBase}..${featureHead}`,
      )
      expect(bySha.diff).toBe(target.diff)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("warns about uncommitted work instead of reviewing it", () =>
    Effect.gen(function* () {
      const { repo, trunk } = yield* makeBranchedRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(repo, "alpha.txt"),
        "first line\nfeature-line\nuncommitted-line\n",
      )
      yield* fs.writeFileString(path.join(repo, "stray.txt"), "stray\n")

      const target = yield* resolveCommitsTarget(repo, trunk)
      expect(target.warnings).toEqual([
        "2 uncommitted file(s) not part of this review",
      ])
      expect(target.diff).not.toContain("uncommitted-line")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses an unresolvable ref and an empty range", () =>
    Effect.gen(function* () {
      const { repo } = yield* makeBranchedRepo

      const missing = yield* Effect.flip(
        resolveCommitsTarget(repo, "no-such-ref"),
      )
      expect(missing._tag).toBe("TargetUnresolvable")
      expect(missing.reason).toContain("could not resolve no-such-ref")

      const empty = yield* Effect.flip(resolveCommitsTarget(repo, "HEAD"))
      expect(empty.reason).toBe("HEAD has no changes to review")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("resolveWorkingTreeTarget with a commit range", () => {
  it.effect("diffs the merge-base against the working tree as submitted", () =>
    Effect.gen(function* () {
      const { featureHead, mergeBase, repo, trunk } = yield* makeBranchedRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(repo, "alpha.txt"),
        "first line\nfeature-line\nuncommitted-line\n",
      )

      const target = yield* resolveWorkingTreeTarget(repo, trunk)
      expect(target._tag).toBe("WorkingTree")
      // The overlay is relative to headCommit, which stays the saved HEAD.
      expect(target.headCommit).toBe(featureHead)
      expect(target.baseCommit).toBe(mergeBase)
      expect(target.diff).toContain("+feature-line")
      expect(target.diff).toContain("+uncommitted-line")

      // Pure --working-tree is the same target without a base.
      const uncommittedOnly = yield* resolveWorkingTreeTarget(repo, undefined)
      expect(uncommittedOnly.baseCommit).toBeUndefined()
      expect(uncommittedOnly.diff).not.toContain("+feature-line")
      expect(uncommittedOnly.diff).toContain("+uncommitted-line")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reports nothing to review when the range and the tree are empty", () =>
    Effect.gen(function* () {
      const { repo } = yield* makeBranchedRepo

      const empty = yield* Effect.flip(resolveWorkingTreeTarget(repo, "HEAD"))
      expect(empty.reason).toBe(
        "HEAD has no committed or uncommitted changes to review",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
