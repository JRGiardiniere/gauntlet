import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { writeArtifactText } from "./artifact.ts"

describe("artifact writes", () => {
  it.effect("replaces longer content without leaving a suffix or temporary files", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const dir = yield* fs.makeTempDirectoryScoped({
        prefix: "gauntlet-artifact-test-",
      })
      const target = path.join(dir, "artifact.md")

      yield* writeArtifactText(target, "a".repeat(4096))
      yield* writeArtifactText(target, "short")

      expect(yield* fs.readFileString(target)).toBe("short")
      expect(yield* fs.readDirectory(dir)).toEqual(["artifact.md"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
