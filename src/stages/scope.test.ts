import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { ReviewTarget } from "../domain/review-target.ts"
import { makeClaudeHost } from "../harness/claude-host.ts"
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
  it.effect("frames an embedded Markdown fence safely, under the root the tools expose", () =>
    Effect.gen(function* () {
      const scope = yield* assembleStageScope(
        yield* loadStageScopeTemplates("workspace-pi.md"),
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
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("tells the model on the Claude Code host about that host's tools", () =>
    Effect.gen(function* () {
      const host = makeClaudeHost(() => undefined, () => undefined)
      const scope = yield* assembleStageScope(
        yield* loadStageScopeTemplates(host.factory.workspacePrompt),
        target,
        host.factory.workspaceRoot(reviewRoot),
        undefined,
      )
      expect(scope).toContain("`Grep`")
      expect(scope).not.toContain("`bash`")
    }).pipe(Effect.provide(NodeServices.layer)))
})
