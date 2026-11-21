import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { ReviewTarget } from "../domain/review-target.ts"
import { assembleStageScope, loadStageScopeTemplates } from "./scope.ts"

const target = ReviewTarget.cases.WorkingTree.make({
  repoRoot: "/fixture/repo",
  headCommit: "abcdef",
  changedFiles: ["README.md"],
  diff: "@@ -1 +1 @@\n context\n ```\n+changed",
  untrackedFiles: [],
  warnings: [],
})

const reviewRoot = "/fixture/review-worktree"

describe("Stage scope block", () => {
  it.effect("frames an embedded Markdown fence safely, under the snapshot root, naming the Host's tools", () =>
    Effect.gen(function* () {
      const scopeTemplates = yield* loadStageScopeTemplates()

      const scope = yield* assembleStageScope(
        scopeTemplates,
        target,
        reviewRoot,
        undefined,
      )

      expect(scope).not.toContain("{{")
      expect(scope).toContain(reviewRoot)
      expect(scope).not.toContain(target.repoRoot)
      expect(scope).toContain("````diff\n")
      expect(scope).toContain("\n ```\n")
      expect(scope).toContain("\n````")
      expect(scope).toContain("`execute`")
      expect(scope).toContain("`tools.shell`")
      expect(scope).not.toContain("`bash`")
    }).pipe(Effect.provide(NodeServices.layer)))
})
