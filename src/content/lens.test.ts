import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { FrozenLens } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  assembleFinderPrompt,
  DEFAULT_CANDIDATE_CAP,
  FINDER_TOOLS,
} from "./finder-prompt.ts"
import { loadLens } from "./lens.ts"

const withFixtureDirectory = <A, E, R>(
  use: (directory: string) => Effect.Effect<A, E, R>,
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const directory = yield* fs.makeTempDirectoryScoped({
        prefix: "gauntlet-lens-test-",
      })
      return yield* use(directory)
    }),
  )

describe("lens content", () => {
  it.effect("loads the three admitted frontmatter fields and hashes exact content", () =>
    withFixtureDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const source = [
          "---",
          "model: acme/fixture-model:low",
          "needs-spec: true",
          "category: fixture-category",
          "---",
          "fixture prompt body",
          "",
        ].join("\n")
        yield* fs.writeFileString(`${directory}/fixture-lens.md`, source)

        const lens = yield* loadLens(directory, "fixture-lens")
        expect(lens).toMatchObject({
          name: "fixture-lens",
          promptText: "fixture prompt body",
          modelOverride: "acme/fixture-model:low",
          needsSpec: true,
          category: "fixture-category",
        })
        expect(lens.contentHash).toBe(
          "bd681019abb8bcfedc0f475036bc0448f49513f21176af3733d39691e518d15c",
        )
      }),
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects any frontmatter field outside the lens format", () =>
    withFixtureDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        yield* fs.writeFileString(
          `${directory}/fixture-lens.md`,
          "---\nrouting: bugs\n---\nfixture body\n",
        )
        const failure = yield* loadLens(directory, "fixture-lens").pipe(
          Effect.flip,
        )
        expect(failure._tag).toBe("ContentLoadError")
        expect(failure.reason).toContain("not admitted: routing")
      }),
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("freezes prompt text and hash before later lens-file edits", () =>
    withFixtureDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const lensPath = `${directory}/fixture-lens.md`
        yield* fs.writeFileString(lensPath, "fixture prompt v1\n")
        const loaded = yield* loadLens(directory, "fixture-lens")
        const frozen = FrozenLens.make({
          name: loaded.name,
          promptText: loaded.promptText,
          contentHash: loaded.contentHash,
          candidateCap: DEFAULT_CANDIDATE_CAP,
        })

        yield* fs.writeFileString(lensPath, "fixture prompt v2\n")
        const reloaded = yield* loadLens(directory, "fixture-lens")
        expect(reloaded.contentHash).not.toBe(frozen.contentHash)

        const target = ReviewTarget.cases.WorkingTree.make({
          repoRoot: "/fixture/repo",
          headCommit: "abcdef",
          changedFiles: ["src/fixture.ts"],
          diff: "+fixture contains {{MODEL_AUTHORED_TOKEN}}",
          warnings: [],
        })
        const prompt = yield* assembleFinderPrompt(
          "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF}}\n{{MAX_PER_LENS}}",
          target,
          frozen,
        )
        expect(prompt).toContain("fixture prompt v1")
        expect(prompt).not.toContain("fixture prompt v2")
        expect(prompt).toContain("{{MODEL_AUTHORED_TOKEN}}")
      }),
    ).pipe(Effect.provide(NodeServices.layer)))
})

describe("finder prompt cache prefix", () => {
  it.effect("puts all shared bytes before the lens tail and keeps tools identical", () =>
    Effect.gen(function* () {
      const target = ReviewTarget.cases.WorkingTree.make({
        repoRoot: "/fixture/repo",
        headCommit: "abcdef",
        changedFiles: ["src/fixture.ts"],
        diff: "+fixture",
        warnings: [],
      })
      const template = [
        "repo={{REPO_ROOT}}",
        "files={{CHANGED_FILES}}",
        "diff={{DIFF}}",
        "cap={{MAX_PER_LENS}}",
      ].join("\n")
      const first = FrozenLens.make({
        name: "fixture-one",
        promptText: "FIRST FIXTURE TAIL",
        contentHash: "hash-one",
        candidateCap: 6,
      })
      const second = FrozenLens.make({
        name: "fixture-two",
        promptText: "SECOND FIXTURE TAIL",
        contentHash: "hash-two",
        candidateCap: 6,
      })
      const firstPrompt = yield* assembleFinderPrompt(template, target, first)
      const secondPrompt = yield* assembleFinderPrompt(template, target, second)
      const firstPrefix = firstPrompt.slice(0, firstPrompt.indexOf(first.promptText))
      const secondPrefix = secondPrompt.slice(0, secondPrompt.indexOf(second.promptText))

      expect(firstPrefix).toBe(secondPrefix)
      expect(firstPrefix).not.toContain(first.name)
      expect(firstPrefix).not.toContain(second.name)
      expect(FINDER_TOOLS).toEqual(["read", "bash"])
    }))

  it.effect("preserves placeholder-like text injected by the diff", () =>
    Effect.gen(function* () {
      const target = ReviewTarget.cases.WorkingTree.make({
        repoRoot: "/fixture/repo",
        headCommit: "abcdef",
        changedFiles: ["src/fixture.ts"],
        diff: '+const marker = "{{MAX_PER_LENS}}"',
        warnings: [],
      })
      const lens = FrozenLens.make({
        name: "fixture-one",
        promptText: "FIXTURE TAIL",
        contentHash: "hash-one",
        candidateCap: 6,
      })
      const prompt = yield* assembleFinderPrompt(
        "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF}}\n{{MAX_PER_LENS}}",
        target,
        lens,
      )

      expect(prompt).toContain('+const marker = "{{MAX_PER_LENS}}"')
      expect(prompt).toContain("\n6\n\nFIXTURE TAIL")
    }))

  it.effect("rejects every unknown placeholder shape", () =>
    Effect.gen(function* () {
      const target = ReviewTarget.cases.WorkingTree.make({
        repoRoot: "/fixture/repo",
        headCommit: "abcdef",
        changedFiles: ["src/fixture.ts"],
        diff: "+fixture",
        warnings: [],
      })
      const lens = FrozenLens.make({
        name: "fixture-one",
        promptText: "FIXTURE TAIL",
        contentHash: "hash-one",
        candidateCap: 6,
      })
      const failure = yield* assembleFinderPrompt(
        "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF}}\n{{MAX_PER_LENS}}\n{{max_per_lens}}",
        target,
        lens,
      ).pipe(Effect.flip)

      expect(failure.reason).toContain("unresolved {{max_per_lens}}")
    }))
})
