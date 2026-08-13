import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import {
  DEFAULT_CANDIDATE_CAP,
  FrozenLens,
} from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  assembleFinderPrompt,
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
  it.effect("loads the admitted frontmatter fields", () =>
    withFixtureDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const source = [
          "---",
          "finder-class: deep",
          "category: fixture-category",
          "---",
          "fixture prompt body",
          "",
        ].join("\n")
        yield* fs.writeFileString(`${directory}/fixture-lens.md`, source)

        const lens = yield* loadLens(directory, "fixture-lens")
        // `category` is admitted (validated above by loading successfully)
        // but not surfaced — it has no consumer until a lens listing exists.
        expect(lens).toEqual({
          name: "fixture-lens",
          promptText: "fixture prompt body",
          finderClass: "deep",
        })
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

        // A concrete lens seat is no longer lens anatomy (ADR 0004): the
        // recipe maps finder classes to seats.
        yield* fs.writeFileString(
          `${directory}/fixture-lens.md`,
          "---\nmodel: acme/fixture-model:low\n---\nfixture body\n",
        )
        const modelFailure = yield* loadLens(directory, "fixture-lens").pipe(
          Effect.flip,
        )
        expect(modelFailure.reason).toContain("not admitted: model")

        // Standard is represented by omission; only `deep` may be declared.
        yield* fs.writeFileString(
          `${directory}/fixture-lens.md`,
          "---\nfinder-class: standard\n---\nfixture body\n",
        )
        const classFailure = yield* loadLens(directory, "fixture-lens").pipe(
          Effect.flip,
        )
        expect(classFailure.reason).toContain(
          "does not match the lens format",
        )

        yield* fs.writeFileString(
          `${directory}/fixture-lens.md`,
          "---\nneeds-spec: true\n---\nfixture body\n",
        )
        const specFailure = yield* loadLens(directory, "fixture-lens").pipe(
          Effect.flip,
        )
        expect(specFailure.reason).toContain("not admitted: needs-spec")
      }),
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("freezes prompt text before later lens-file edits", () =>
    withFixtureDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const lensPath = `${directory}/fixture-lens.md`
        yield* fs.writeFileString(lensPath, "fixture prompt v1\n")
        const loaded = yield* loadLens(directory, "fixture-lens")
        expect(loaded.finderClass).toBe("standard")
        const frozen = FrozenLens.make({
          name: loaded.name,
          promptText: loaded.promptText,
          seat: "fixture/fixture-model:low",
          candidateCap: DEFAULT_CANDIDATE_CAP,
        })

        yield* fs.writeFileString(lensPath, "fixture prompt v2\n")
        const reloaded = yield* loadLens(directory, "fixture-lens")
        expect(reloaded.promptText).not.toBe(frozen.promptText)

        const target = ReviewTarget.cases.WorkingTree.make({
          repoRoot: "/fixture/repo",
          headCommit: "abcdef",
          changedFiles: ["src/fixture.ts"],
          diff: "+fixture contains {{MODEL_AUTHORED_TOKEN}}",
          untrackedFiles: [],
          warnings: [],
        })
        const prompt = yield* assembleFinderPrompt(
          "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}\n{{MAX_PER_LENS}}",
          target,
          target.repoRoot,
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
        untrackedFiles: [],
        warnings: [],
      })
      const template = [
        "repo={{REPO_ROOT}}",
        "files={{CHANGED_FILES}}",
        "{{DIFF_SECTION}}",
        "cap={{MAX_PER_LENS}}",
      ].join("\n")
      const first = FrozenLens.make({
        name: "fixture-one",
        promptText: "FIRST FIXTURE TAIL",
        seat: "fixture/fixture-model:low",
        candidateCap: 6,
      })
      const second = FrozenLens.make({
        name: "fixture-two",
        promptText: "SECOND FIXTURE TAIL",
        seat: "fixture/fixture-model:low",
        candidateCap: 6,
      })
      const firstPrompt = yield* assembleFinderPrompt(
        template,
        target,
        target.repoRoot,
        first,
      )
      const secondPrompt = yield* assembleFinderPrompt(
        template,
        target,
        target.repoRoot,
        second,
      )
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
        untrackedFiles: [],
        warnings: [],
      })
      const lens = FrozenLens.make({
        name: "fixture-one",
        promptText: "FIXTURE TAIL",
        seat: "fixture/fixture-model:low",
        candidateCap: 6,
      })
      const prompt = yield* assembleFinderPrompt(
        "{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}\n{{MAX_PER_LENS}}",
        target,
        target.repoRoot,
        lens,
      )

      expect(prompt).toContain('+const marker = "{{MAX_PER_LENS}}"')
      expect(prompt).toContain("\n6\n\nFIXTURE TAIL")
    }))

  it.effect("keeps an override out of the shared prefix", () =>
    Effect.gen(function* () {
      const target = ReviewTarget.cases.WorkingTree.make({
        repoRoot: "/fixture/repo",
        headCommit: "abcdef",
        changedFiles: ["src/fixture.ts"],
        diff: "+fixture",
        untrackedFiles: [],
        warnings: [],
      })
      const template = "shared cap={{MAX_PER_LENS}}\n{{REPO_ROOT}}\n{{CHANGED_FILES}}\n{{DIFF_SECTION}}"
      const ordinary = FrozenLens.make({
        name: "fixture-ordinary",
        promptText: "ORDINARY TAIL",
        seat: "fixture/fixture-model:low",
        candidateCap: 6,
      })
      const expanded = FrozenLens.make({
        name: "fixture-expanded",
        promptText: "EXPANDED TAIL",
        seat: "fixture/fixture-model:low",
        candidateCap: 12,
      })
      const ordinaryPrompt = yield* assembleFinderPrompt(
        template,
        target,
        target.repoRoot,
        ordinary,
      )
      const expandedPrompt = yield* assembleFinderPrompt(
        template,
        target,
        target.repoRoot,
        expanded,
      )
      const ordinaryPrefix = ordinaryPrompt.slice(
        0,
        ordinaryPrompt.indexOf(ordinary.promptText),
      )
      const expandedPrefix = expandedPrompt.slice(
        0,
        expandedPrompt.indexOf(expanded.promptText),
      )
      expect(expandedPrefix).toBe(ordinaryPrefix)
      expect(expandedPrefix).toContain("shared cap=6")
      expect(expandedPrompt.indexOf("EXPANDED TAIL")).toBeLessThan(
        expandedPrompt.indexOf("at most 12 findings"),
      )
    }))
})
