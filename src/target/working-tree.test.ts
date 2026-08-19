import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ReviewTarget } from "../domain/review-target.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { runGit } from "./git.ts"
import { resolveWorkingTreeTarget } from "./working-tree.ts"

const makeDirtyRepo = Effect.gen(function* () {
  const { repo } = yield* makeGitFixture({ prefix: "gauntlet-working-tree-" })
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.writeFileString(path.join(repo, "alpha.txt"), "first line\n")
  yield* commitAll(repo, "initial")
  yield* fs.writeFileString(
    path.join(repo, "alpha.txt"),
    "first line\nchanged\n",
  )
  return repo
})

describe("resolveWorkingTreeTarget", () => {
  it.effect("names included untracked files without carrying their bytes", () =>
    Effect.gen(function* () {
      const repo = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(repo, "stray.txt"),
        "stray-untracked-payload\n",
      )

      const target = yield* resolveWorkingTreeTarget(repo, undefined)
      expect(target._tag).toBe("WorkingTree")
      expect(target.untrackedFiles).toEqual(["stray.txt"])
      expect(target.warnings).toEqual([
        "1 untracked file(s) not included in the diff: stray.txt",
      ])
      // Untracked content reaches /repo through the workspace overlay, never
      // through the target.
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(ReviewTarget),
      )(target)
      expect(encoded).not.toContain("stray-untracked-payload")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("omits files ignored only through core.excludesFile", () =>
    Effect.gen(function* () {
      const { repo } = yield* makeGitFixture({
        prefix: "gauntlet-working-tree-excludes-",
      })
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(repo, "alpha.txt"), "first line\n")
      yield* fs.writeFileString(path.join(repo, ".gitignore"), "ignored.txt\n")
      yield* commitAll(repo, "initial")
      yield* fs.writeFileString(
        path.join(repo, "alpha.txt"),
        "first line\nchanged\n",
      )
      const excludesFile = path.join(repo, "..", "excludes")
      yield* fs.writeFileString(excludesFile, "secret.env\n")
      yield* runGit(repo, ["config", "core.excludesFile", excludesFile])
      yield* fs.writeFileString(path.join(repo, "visible.txt"), "keep\n")
      yield* fs.writeFileString(path.join(repo, "secret.env"), "token=hidden\n")
      yield* fs.writeFileString(path.join(repo, "ignored.txt"), "gitignore\n")

      const target = yield* resolveWorkingTreeTarget(repo, undefined)
      expect(target.untrackedFiles).toEqual(["visible.txt"])
      expect(target.warnings.join("\n")).toContain("visible.txt")
      const encoded = yield* Schema.encodeEffect(
        Schema.fromJsonString(ReviewTarget),
      )(target)
      expect(encoded).not.toContain("secret.env")
      expect(encoded).not.toContain("ignored.txt")
      expect(encoded).not.toContain("token=hidden")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("excludes untracked files over 10MB with a scope-degradation warning", () =>
    Effect.gen(function* () {
      const repo = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(path.join(repo, "small.txt"), "ok\n")
      yield* fs.writeFile(
        path.join(repo, "at-cap.bin"),
        new Uint8Array(Number(FileSystem.MiB(10))),
      )
      yield* fs.writeFile(
        path.join(repo, "huge.bin"),
        new Uint8Array(Number(FileSystem.MiB(10)) + 1),
      )

      const target = yield* resolveWorkingTreeTarget(repo, undefined)
      expect(target.untrackedFiles).toEqual(["at-cap.bin", "small.txt"])
      expect(target.warnings).toEqual([
        "2 untracked file(s) not included in the diff: at-cap.bin, small.txt",
        "1 untracked file(s) exceed 10MB and are excluded from the review: huge.bin",
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("does not abort on untracked symlinks or nested repositories", () =>
    Effect.gen(function* () {
      const repo = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.symlink(
        "missing-target",
        path.join(repo, "dangling"),
      )
      const nested = path.join(repo, "nested")
      yield* fs.makeDirectory(nested)
      yield* runGit(nested, ["init"])

      const target = yield* resolveWorkingTreeTarget(repo, undefined)
      expect(target.untrackedFiles).toEqual(["dangling"])
      expect(target.warnings[0]).toContain("dangling")
      expect(target.warnings[0]).toContain("nested")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
