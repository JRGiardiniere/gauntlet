import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { Dossier } from "../domain/dossier.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import {
  GitHubError,
  gitHubLayer,
  unusedGitHubContract,
  unusedGitHubLayer,
} from "../github/github.ts"
import { makeScripted, type Scripted } from "../harness/scripted.ts"
import { FinderStageArtifact } from "../run/finder-execution.ts"
import { viewDossier } from "../render/dossier-view.ts"
import {
  confinedSession,
  FINDER_OUTPUT,
  inspectionsFor,
  JUDGMENT_OUTPUT,
  makeDirtyRepo,
  makePrReviewFixture,
  promptTextsFor,
  provideReviewFixture,
  prView,
  successfulScripted,
  systemPromptsFor,
  VERIFIER_OUTPUT,
  type Fixture,
} from "../test-support/review.fixture.ts"
import { REVIEW_WORKSPACE_ROOT } from "../workspace/review-workspace.ts"
import { runGauntlet } from "./main.ts"

// The CLI's own contracts: argv in, the stdout digest, `gauntlet: ` lines on
// stderr, the exit code and the run directory. What a review does is the Run
// module's suite (src/run/run.test.ts); the words a review takes are the
// syntax's (src/syntax/syntax.test.ts).

const runCommand = (
  fixture: Fixture,
  argv: ReadonlyArray<string>,
  scripted: Scripted,
  github = unusedGitHubLayer,
) => ({
  scripted,
  effect: runGauntlet(argv).pipe(
    provideReviewFixture(fixture, scripted, github),
  ),
})

const review = (fixture: Fixture, scripted: Scripted) =>
  runCommand(fixture, ["review", "--lenses", "fixture-review"], scripted)

describe("gauntlet review", () => {
  it.effect("reviews the working tree when no target is named, through persisted artifacts and presentation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "untracked.txt"),
        "not in the diff\n",
      )
      const run = review(
        fixture,
        makeScripted({
          sessions: [
            confinedSession(FINDER_OUTPUT, "-finders", {
              bash: ["pwd"],
              read: ["alpha.txt"],
            }),
            confinedSession(VERIFIER_OUTPUT, "-verification"),
            confinedSession(JUDGMENT_OUTPUT, "-judgment"),
          ],
        }),
      )

      const exitCode = yield* run.effect
      expect(exitCode).toBe(0)

      const runIds = yield* fs.readDirectory(fixture.runsRoot)
      expect(runIds).toHaveLength(1)
      const runDir = path.join(fixture.runsRoot, runIds[0] ?? "")

      const entries = yield* fs.readDirectory(runDir)
      expect([...entries].sort()).toEqual([
        "dossier.json",
        "dossier.md",
        "finder-stage.json",
        "plan.json",
        "run.log",
        "workspace-overlay.patch",
      ])

      const planText = yield* fs.readFileString(path.join(runDir, "plan.json"))
      const plan = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))(
        planText,
      )
      expect(plan.runId).toBe(runIds[0])
      const finderStageText = yield* fs.readFileString(
        path.join(runDir, "finder-stage.json"),
      )
      const finderStage = yield* Schema.decodeEffect(
        Schema.fromJsonString(FinderStageArtifact),
      )(finderStageText)
      expect(finderStage.runId).toBe(plan.runId)
      expect(finderStage.finders).toHaveLength(1)
      expect(finderStage.finders[0]?.outcome.termination._tag).toBe("Completed")
      expect(finderStage.finders[0]?.outcome.output).toEqual(FINDER_OUTPUT)
      expect(finderStage.finders[0]?.outcome.usage.rawRows).toHaveLength(1)

      const dossierText = yield* fs.readFileString(path.join(runDir, "dossier.json"))
      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(
        dossierText,
      )
      expect(dossier.runId).toBe(plan.runId)
      const dossierView = viewDossier(dossier)
      const confirmed = dossierView.findings.find(
        ({ tag }) => tag === "confirmed",
      )
      expect(confirmed?.candidate._tag).toBe("BugClaim")
      expect(confirmed?.candidate.id).toBe("fixture-review/1")
      expect(confirmed).toMatchObject({
        reviewPriority: "P2",
        detail: "empty input reaches the added line and throws",
        testSuggestion: {
          tests: ["the alpha input suite"],
          reason: "it exercises empty inputs against the added line",
          bugClaimIds: ["fixture-review/1"],
        },
      })
      const judgment = dossierView.findings.find(
        ({ tag }) => tag === "judgment",
      )
      expect(judgment?.candidate._tag).toBe("Observation")
      expect(judgment?.candidate.id).toBe("fixture-review/2")
      expect(judgment).toMatchObject({
        reviewPriority: "P2",
      })
      expect(dossier.coverageGaps).toEqual([])

      const report = yield* fs.readFileString(path.join(runDir, "dossier.md"))
      expect(report).toContain(`# Gauntlet review ${plan.runId}`)
      expect(report).toContain("the added line breaks empty inputs")
      expect(report).toContain(
        "suggested tests: the alpha input suite — it exercises empty inputs against the added line",
      )
      expect(report).toContain("the name hides the value's role")
      expect(report).toContain("3 invocations")
      expect(report).toContain(
        "Recipe: fixture-recipe (pool: fixture/fixture-model:low, verification: fixture/fixture-model:low, judgment: fixture/fixture-model:low)",
      )
      expect(report).toContain("- Warnings: ")
      expect(report).toContain("untracked.txt")

      // The review diff is stored exactly once, in the plan (ADR 0006). The
      // workspace overlay is a separate artifact and is not one of these.
      const runRecordText = planText + finderStageText + dossierText + report
      expect(runRecordText.split("needle-added-line").length - 1).toBe(1)
      expect(runRecordText).not.toContain("not in the diff")

      expect(run.scripted.configs).toHaveLength(3)
      const snapshot = run.scripted.configs[0]?.cwd ?? "worktree path missing"
      for (const config of run.scripted.configs) {
        expect(config.cwd).toBe(snapshot)
        expect(config.cwd).not.toBe(fixture.repo)
        expect(config.tools).toEqual(["read", "bash"])
      }
      const finderInspections = inspectionsFor(run.scripted, "-finders")
      expect(finderInspections).toHaveLength(2)
      expect(finderInspections[0]).toMatchObject({
        toolName: "bash",
        isError: false,
      })
      expect(finderInspections[0]?.text).toContain(REVIEW_WORKSPACE_ROOT)
      expect(finderInspections[0]?.text).not.toContain(snapshot)
      expect(finderInspections[1]).toMatchObject({
        toolName: "read",
        isError: false,
      })
      expect(finderInspections[1]?.text).toContain("needle-added-line")
      expect(finderInspections[1]?.text).not.toContain(snapshot)

      for (const suffix of ["-verification", "-judgment"] as const) {
        const [pwd] = inspectionsFor(run.scripted, suffix)
        expect(pwd?.toolName).toBe("bash")
        expect(pwd?.isError).toBe(false)
        expect(pwd?.text).toContain(REVIEW_WORKSPACE_ROOT)
        expect(pwd?.text).not.toContain(snapshot)
      }

      // Finders carry the repo root in the system prompt; the later stages
      // carry it in the user prompt.
      const [finderSystemPrompt = ""] = systemPromptsFor(run.scripted, "-finders")
      expect(finderSystemPrompt).toContain(`repo=${REVIEW_WORKSPACE_ROOT}`)
      expect(finderSystemPrompt).not.toContain(snapshot)
      for (const suffix of ["-verification", "-judgment"] as const) {
        const [prompt = ""] = promptTextsFor(run.scripted, suffix)
        expect(prompt).toContain(`repo=${REVIEW_WORKSPACE_ROOT}`)
        expect(prompt).not.toContain(snapshot)
      }

      const runLog = yield* fs.readFileString(path.join(runDir, "run.log"))
      expect(runLog.length).toBeGreaterThan(0)

      const stdout = (yield* TestConsole.logLines).join("\n")
      const [tally = ""] = stdout.split("\n")
      expect(tally).toContain("1 confirmed · 1 kept · 0 plausible · 0 undecided")
      expect(tally).toContain("working tree @")
      expect(tally).toContain("recipe: fixture-recipe")
      expect(tally).toMatch(/ — \d+s$/)
      expect(stdout).toContain("- [P2 confirmed] alpha.txt:2")
      expect(stdout).toContain(
        "- [P2 judgment] alpha.txt — the name hides the value's role",
      )
      expect(stdout).toContain(`dossier.md: ${fixture.runsRoot}`)
      expect(stdout).toContain("dossier.json")
      expect(stdout).not.toContain("gauntlet:")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("renders a refusal as one stderr line and exits 1", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem

      const aimed = runCommand(
        fixture,
        ["review", "7", "--working-tree"],
        makeScripted({ sessions: [] }),
      )
      expect(yield* aimed.effect).toBe(1)

      yield* fs.writeFileString(fixture.settingsFile, "{ not json\n")
      const unreadable = review(fixture, makeScripted({ sessions: [] }))
      expect(yield* unreadable.effect).toBe(1)

      const stderr = yield* TestConsole.errorLines
      expect(stderr[0]).toBe(
        "gauntlet: could not review — --working-tree extends only a commit base; a pull request or a <base>..<head> range has its own head",
      )
      expect(stderr.at(-1)).toMatch(
        new RegExp(`^gauntlet: .*\\(${fixture.settingsFile}\\)$`),
      )
      expect(yield* TestConsole.logLines).toEqual([])
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("gauntlet deliver", () => {
  it.effect("names the retry when a pull request's post may have landed, then posts the Run", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      const url = "https://github.com/example/repo/pull/7#issuecomment-1"
      const github = (posted: boolean) =>
        gitHubLayer({
          ...unusedGitHubContract,
          viewPullRequest: () => Effect.succeed(prView(7, headCommit, baseCommit)),
          viewClosingIssues: () => Effect.succeed([]),
          postComment: () =>
            posted
              ? Effect.succeed({ url })
              : Effect.fail(
                new GitHubError({ operation: "post", reason: "gh timed out" }),
              ),
        })

      const reviewed = runCommand(
        fixture,
        ["review", "7", "--destination", "pr", "--lenses", "fixture-review"],
        successfulScripted(),
        github(false),
      )
      expect(yield* reviewed.effect).toBe(1)
      const [runId = ""] = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readDirectory(fixture.runsRoot)),
      )
      expect((yield* TestConsole.logLines).join("\n")).toContain("dossier.md: ")
      expect((yield* TestConsole.errorLines).at(-1)).toBe(
        `gauntlet: could not deliver — gh timed out; check the PR for the comment before retrying with gauntlet deliver ${runId}`,
      )

      const delivered = runCommand(
        fixture,
        ["deliver", runId],
        makeScripted({ sessions: [] }),
        github(true),
      )
      expect(yield* delivered.effect).toBe(0)
      expect((yield* TestConsole.logLines).at(-1)).toBe(url)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
