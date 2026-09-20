import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { Candidate } from "../domain/candidate.ts"
import { assembleSourceContext } from "./source-context.ts"

const claim = (id: string, sourceReferences: ReadonlyArray<string> = []) =>
  Candidate.cases.BugClaim.make({
    id,
    lens: "fixture",
    file: "app.ts",
    summary: "A claim",
    failureScenario: "A scenario",
    sourceReferences,
  })

const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const directory = yield* fs.makeTempDirectoryScoped()
  const snapshot = path.join(directory, "snapshot")
  yield* fs.makeDirectory(snapshot)
  yield* fs.writeFileString(path.join(snapshot, "app.ts"),
    'import { guard } from "./guard.ts"\nconst getUser = () => {\n  return guard()\n}\n')
  yield* fs.writeFileString(path.join(snapshot, "guard.ts"), 'export const guard = () => false\n')
  return { fs, path, directory, snapshot }
})

describe("source context", () => {
  it.effect("preserves complete snapshot files and includes shared dependencies only once", () =>
    Effect.gen(function* () {
      const { fs, path, directory, snapshot } = yield* fixture
      // A different version outside the snapshot must never supply the context.
      yield* fs.writeFileString(path.join(directory, "app.ts"), "current checkout changed")
      const result = yield* assembleSourceContext(snapshot, [
        claim("a", ["app.ts", "guard.ts"]),
        claim("b", ["guard.ts", "./app.ts"]),
      ], 1000)
      expect(result.omissions).toEqual([])
      expect(result.files).toEqual([
        { file: "app.ts", text: 'import { guard } from "./guard.ts"\nconst getUser = () => {\n  return guard()\n}\n' },
        { file: "guard.ts", text: "export const guard = () => false\n" },
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps missing context visible while collecting available files", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* fixture
      const result = yield* assembleSourceContext(snapshot, [claim("old"),
        claim("new", ["missing.ts", "guard.ts"])], 1000)
      expect(result.files.map((item) => item.file)).toEqual(["guard.ts"])
      expect(result.omissions).toEqual([
        { candidateId: "old", reason: "no source references" },
        { candidateId: "new", file: "missing.ts", reason: "file is missing from the review snapshot" },
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("rejects traversal and symlink escapes, including Git metadata", () =>
    Effect.gen(function* () {
      const { fs, path, directory, snapshot } = yield* fixture
      const outside = path.join(directory, "outside.ts")
      yield* fs.writeFileString(outside, "private host content")
      yield* fs.writeFileString(path.join(snapshot, ".git"), "gitdir: private")
      yield* fs.symlink(outside, path.join(snapshot, "escape.ts"))
      yield* fs.symlink(path.join(snapshot, ".git"), path.join(snapshot, "metadata.ts"))
      const files = ["../outside.ts", outside, "escape.ts", ".git", "metadata.ts", "https://example.com/a", "C:\\secret.ts"]
      const result = yield* assembleSourceContext(snapshot, [claim("a", files)], 1000)
      expect(result.files).toEqual([])
      expect(result.omissions).toHaveLength(files.length)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("honors the aggregate budget without truncating or charging duplicates twice", () =>
    Effect.gen(function* () {
      const { fs, path, snapshot } = yield* fixture
      yield* fs.writeFileString(path.join(snapshot, "first.ts"), "123456")
      yield* fs.writeFileString(path.join(snapshot, "second.ts"), "abcdef")
      yield* fs.writeFileString(path.join(snapshot, "small.ts"), "7890")
      const result = yield* assembleSourceContext(snapshot, [
        claim("a", ["first.ts", "first.ts", "second.ts", "small.ts"]),
      ], 10)
      expect(result.files).toEqual([
        { file: "first.ts", text: "123456" }, { file: "small.ts", text: "7890" },
      ])
      expect(result.characters).toBe(10)
      expect(result.omissions).toEqual([{
        candidateId: "a", file: "second.ts",
        reason: "whole file exceeds the remaining source character budget",
      }])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("excludes binary and oversized files rather than sending partial source", () =>
    Effect.gen(function* () {
      const { fs, path, snapshot } = yield* fixture
      yield* fs.writeFileString(path.join(snapshot, "binary"), "abc\0def")
      yield* fs.writeFileString(path.join(snapshot, "huge.ts"), "a".repeat(1024 * 1024 + 1))
      const result = yield* assembleSourceContext(snapshot, [claim("a", ["binary", "huge.ts"])], 2_000_000)
      expect(result.files).toEqual([])
      expect(result.omissions.map((item) => item.file)).toEqual(["binary", "huge.ts"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
