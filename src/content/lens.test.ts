import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { FrozenLens } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import { assembleFinderPrompt } from "./finder-prompt.ts"
import {
  ContentDirectory,
  loadFinderLensCatalog,
  loadFinderLenses,
  loadLens,
} from "./lens.ts"

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
          "finder-class: interpretive",
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
          finderClass: "interpretive",
        })
      }),
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("rejects lens-owned seats and unsupported finder classes", () =>
    withFixtureDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        // Recipes own seats; lenses choose only a finder class.
        yield* fs.writeFileString(
          `${directory}/fixture-lens.md`,
          "---\nmodel: acme/fixture-model:low\n---\nfixture body\n",
        )
        const modelFailure = yield* loadLens(directory, "fixture-lens").pipe(
          Effect.flip,
        )
        expect(modelFailure.reason).toContain("not admitted: model")

        // Specific is represented by omission; the only declared class is interpretive.
        yield* fs.writeFileString(
          `${directory}/fixture-lens.md`,
          "---\nfinder-class: standard\n---\nfixture body\n",
        )
        const classFailure = yield* loadLens(directory, "fixture-lens").pipe(
          Effect.flip,
        )
        expect(classFailure.reason).toContain(
          'finder-class admits exactly "interpretive"',
        )
        expect(classFailure.reason).toContain('got "standard"')
      }),
    ).pipe(Effect.provide(NodeServices.layer)))

  it.effect("decodes selected content for review and the full catalog for config", () =>
    withFixtureDirectory((directory) =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const content = `${directory}/content`
        const repo = `${directory}/repo`
        yield* fs.makeDirectory(`${content}/lenses`, { recursive: true })
        yield* fs.makeDirectory(`${repo}/.gauntlet/lenses`, { recursive: true })
        yield* fs.writeFileString(
          `${content}/lenses/selected.md`,
          "selected prompt\n",
        )
        yield* fs.writeFileString(
          `${repo}/.gauntlet/lenses/unselected.md`,
          "---\nrouting: bugs\n---\ninvalid unselected prompt\n",
        )

        const selected = yield* loadFinderLenses({
          repoRoot: repo,
          names: ["selected"],
        }).pipe(Effect.provideService(ContentDirectory, content))
        expect(selected).toEqual([{
          name: "selected",
          promptText: "selected prompt\n",
          finderClass: "specific",
        }])

        const catalogFailure = yield* loadFinderLensCatalog(repo).pipe(
          Effect.provideService(ContentDirectory, content),
          Effect.flip,
        )
        expect(catalogFailure.reason).toContain("not admitted: routing")
        expect(catalogFailure.path).toContain("unselected.md")
      }),
    ).pipe(Effect.provide(NodeServices.layer)))
})

describe("finder prompt cache prefix", () => {
  it.effect("shares the unchanged diff and default cap before each lens assignment", () =>
    Effect.gen(function* () {
      const target = ReviewTarget.cases.WorkingTree.make({
        repoRoot: "/fixture/repo",
        headCommit: "abcdef",
        changedFiles: ["src/fixture.ts"],
        diff: '+const marker = "{{MAX_PER_LENS}}"',
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
        undefined,
      )
      const expandedPrompt = yield* assembleFinderPrompt(
        template,
        target,
        target.repoRoot,
        expanded,
        undefined,
      )
      expect(ordinaryPrompt).toContain(ordinary.promptText)
      expect(expandedPrompt).toContain(expanded.promptText)
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
      expect(expandedPrefix).toContain('+const marker = "{{MAX_PER_LENS}}"')
      expect(expandedPrefix).not.toContain(ordinary.name)
      expect(expandedPrefix).not.toContain(expanded.name)
      expect(expandedPrompt.indexOf(expanded.promptText)).toBeLessThan(
        expandedPrompt.indexOf("at most 12 findings"),
      )
    }))
})
