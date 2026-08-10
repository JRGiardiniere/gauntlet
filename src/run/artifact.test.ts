import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Schema from "effect/Schema"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { writeArtifactJson, writeArtifactText } from "./artifact.ts"

const Fixture = Schema.Struct({
  label: Schema.NonEmptyString,
  count: Schema.Int,
})

describe("artifact writes", () => {
  it.effect("writes JSON atomically in the artifact's own directory", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gauntlet-artifact-test-"))
      const target = join(dir, "fixture.json")

      yield* writeArtifactJson(target, Fixture, { label: "one", count: 1 })

      const fs = yield* FileSystem.FileSystem
      const text = yield* fs.readFileString(target)
      const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Fixture))(text)
      expect(decoded).toEqual({ label: "one", count: 1 })

      // No temp-file debris survives a completed write.
      expect(yield* fs.readDirectory(dir)).toEqual(["fixture.json"])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("replaces existing content whole, never partially", () =>
    Effect.gen(function* () {
      const dir = mkdtempSync(join(tmpdir(), "gauntlet-artifact-test-"))
      const target = join(dir, "artifact.md")

      yield* writeArtifactText(target, "a".repeat(4096))
      yield* writeArtifactText(target, "short")

      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString(target)).toBe("short")
      expect(yield* fs.readDirectory(dir)).toEqual(["artifact.md"])
    }).pipe(Effect.provide(NodeServices.layer)))
})
