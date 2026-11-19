import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { RELATIVE_REPO_ROOT } from "../content/finder-prompt.ts"
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
  emittingSession,
  FINDER_OUTPUT,
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
            emittingSession(FINDER_OUTPUT, "-finders", 2),
            emittingSession(VERIFIER_OUTPUT, "-verification", 1),
            emittingSession(JUDGMENT_OUTPUT, "-judgment", 1),
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
      const confirmed = Array.findFirst(
        dossierView.findings,
        ({ tag }) => tag === "confirmed",
      )
      expect(Option.map(confirmed, ({ candidate }) => candidate._tag)).toEqual(Option.some("BugClaim"))
      expect(Option.map(confirmed, ({ candidate }) => candidate.id)).toEqual(Option.some("fixture-review/1"))
      expect(Option.getOrUndefined(confirmed)).toMatchObject({
        reviewPriority: "P2",
        detail: "empty input reaches the added line and throws",
        testSuggestion: {
          tests: ["the alpha input suite"],
          reason: "it exercises empty inputs against the added line",
          bugClaimIds: ["fixture-review/1"],
        },
      })
      const judgment = Array.findFirst(
        dossierView.findings,
        ({ tag }) => tag === "judgment",
      )
      expect(Option.map(judgment, ({ candidate }) => candidate._tag)).toEqual(Option.some("Observation"))
      expect(Option.map(judgment, ({ candidate }) => candidate.id)).toEqual(Option.some("fixture-review/2"))
      expect(Option.getOrUndefined(judgment)).toMatchObject({
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

      expect(run.scripted.specs).toHaveLength(3)
      const snapshot = run.scripted.specs[0]?.workspace ?? "worktree path missing"
      for (const spec of run.scripted.specs) {
        expect(spec.workspace).toBe(snapshot)
        expect(spec.workspace).not.toBe(fixture.repo)
        expect(spec.tools).toEqual(["read", "grep", "glob"])
      }
      expect(Array.map(run.scripted.specs, (spec) => spec.role)).toEqual(["finder-1", "verifier", "judge"])

      // Finders name the root relatively, so their prefix holds no per-Run
      // path; the later stages carry the snapshot root in the user prompt.
      const [finderSystemPrompt = ""] = systemPromptsFor(run.scripted, "-finders")
      expect(finderSystemPrompt).toContain(`repo=${RELATIVE_REPO_ROOT}`)
      expect(finderSystemPrompt).not.toContain(snapshot)
      for (const suffix of ["-verification", "-judgment"] as const) {
        const [prompt = ""] = promptTextsFor(run.scripted, suffix)
        expect(prompt).toContain(`Repo root: ${snapshot}`)
      }

      const runLog = yield* fs.readFileString(path.join(runDir, "run.log"))
      expect(runLog.length).toBeGreaterThan(0)

      const logLines = yield* TestConsole.logLines
      const stdout = Array.join(Array.map(logLines, String), "\n")
      const [tally = ""] = stdout.split("\n")
      expect(tally).toContain("1 confirmed · 1 kept · 0 plausible · 0 undecided")
      expect(tally).toContain("working tree @")
      expect(tally).toContain("recipe: fixture-recipe")
      expect(tally).toMatch(/ — \d+s$/)
      expect(stdout).toContain(
        "P2 (2)\n- [confirmed] alpha.txt:2 — the added line breaks empty inputs\n- [judgment] alpha.txt — the name hides the value's role",
      )
      expect(stdout).toMatch(/\n- Total: \S+ in .* out\n/)
      expect(stdout).toContain(`dossier.md: ${path.join(runDir, "dossier.md")}`)
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
      const aimedExit = yield* aimed.effect
      expect(aimedExit).toBe(1)

      yield* fs.writeFileString(fixture.settingsFile, "{ not json\n")
      const unreadable = review(fixture, makeScripted({ sessions: [] }))
      const unreadableExit = yield* unreadable.effect
      expect(unreadableExit).toBe(1)

      const stderr = yield* TestConsole.errorLines
      expect(stderr[0]).toBe(
        "gauntlet: could not review — --working-tree extends only a commit base; a pull request or a <base>..<head> range has its own head",
      )
      expect(stderr.at(-1)).toMatch(
        new RegExp(`^gauntlet: .*\\(${fixture.settingsFile}\\)$`),
      )
      const logLines = yield* TestConsole.logLines
      expect(logLines).toEqual([])
      const runsRootExists = yield* fs.exists(fixture.runsRoot)
      expect(runsRootExists).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("gauntlet deliver", () => {
  it.effect("prints the digest before a pull request's post, names the retry when the post may have landed, then posts the Run", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      const url = "https://github.com/example/repo/pull/7#issuecomment-1"
      let stdoutAtPost = ""
      const github = (posted: boolean) =>
        gitHubLayer({
          ...unusedGitHubContract,
          viewPullRequest: () => Effect.succeed(prView(7, headCommit, baseCommit)),
          postComment: () =>
            posted
              ? Effect.succeed({ url })
              : TestConsole.logLines.pipe(
                Effect.flatMap((lines) => {
                  stdoutAtPost = Array.join(Array.map(lines, String), "\n")
                  return Effect.fail(
                    GitHubError.make({ operation: "post", reason: "gh timed out" }),
                  )
                }),
              ),
        })

      const reviewed = runCommand(
        fixture,
        ["review", "7", "--destination", "pr", "--lenses", "fixture-review"],
        successfulScripted(),
        github(false),
      )
      const reviewedExit = yield* reviewed.effect
      expect(reviewedExit).toBe(1)
      const [runId = ""] = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readDirectory(fixture.runsRoot)),
      )
      expect(stdoutAtPost).toContain("dossier.md: ")
      expect((yield* TestConsole.errorLines).at(-1)).toBe(
        `gauntlet: could not deliver — gh timed out; check the PR for the comment before retrying with gauntlet deliver ${runId}`,
      )

      const delivered = runCommand(
        fixture,
        ["deliver", runId],
        makeScripted({ sessions: [] }),
        github(true),
      )
      const deliveredExit = yield* delivered.effect
      expect(deliveredExit).toBe(0)
      expect((yield* TestConsole.logLines).at(-1)).toBe(url)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

// The fixture's Host dies on any use, so each of these exiting cleanly shows
// it never booted (#197): only login and upgrade load OpenCode.
describe("commands that never boot the Host", () => {
  it.effect.each([
    { argv: ["--help"] },
    { argv: ["--version"] },
    { argv: ["config"] },
    { argv: ["config", "init"] },
    { argv: ["login", "--help"] },
  ])("gauntlet $argv", ({ argv }) =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const run = runCommand(fixture, argv, makeScripted({ sessions: [] }))
      const exitCode = yield* run.effect
      expect(exitCode).toBe(0)
      const output = yield* TestConsole.logLines
      expect(output).not.toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
