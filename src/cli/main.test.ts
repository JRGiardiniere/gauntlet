import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { ContentDirectory } from "../content/lens.ts"
import { Dossier } from "../domain/dossier.ts"
import { SPEC_CONFORMANCE_LENS_NAME } from "../domain/finder-selection.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  GitHubError,
  gitHubLayer,
  unusedGitHubContract,
  unusedGitHubLayer,
  type GitHubClosingIssue,
} from "../github/github.ts"
import {
  Linear,
  unusedLinearLayer,
} from "../linear/linear.ts"
import {
  makeScripted,
  scriptedLayer,
  type Scripted,
  type ScriptedPrompt,
  type ScriptedSession,
  usageRow,
} from "../harness/scripted.ts"
import type {
  FindingsOutput,
  PoolOutput,
  VerdictsOutput,
} from "../harness/output-contract.ts"
import {
  FinderCacheSettle,
  FinderStageArtifact,
  FinderStageCheckpoint,
} from "../run/finder-execution.ts"
import type { JudgmentsOutput } from "../stages/judgment/output-contract.ts"
import { viewDossier } from "../render/dossier-view.ts"
import { runGit } from "../target/git.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import { commitAll } from "../test-support/git.fixture.ts"
import {
  closingIssue,
  FIXTURE_SEAT,
  linearBranchIssue,
  makeCommitRangeFixture,
  makeDirtyRepo,
  makePrReviewFixture,
  prView,
  writeRecipe,
  writeSettings,
  type Fixture,
} from "../test-support/review.fixture.ts"
import { REVIEW_WORKSPACE_ROOT } from "../workspace/review-workspace.ts"
import { runGauntlet } from "./main.ts"

const FINDER_OUTPUT = {
  findings: [
    {
      file: "alpha.txt",
      line: 2,
      summary: "the added line breaks empty inputs",
      failure_scenario: "an empty input reaches the new line and throws",
    },
    {
      file: "alpha.txt",
      summary: "the name hides the value's role",
    },
  ],
} satisfies FindingsOutput

// The four stage outputs a scripted session can emit. The harness keeps emit
// args `unknown` because it is a generic adapter seam; these helpers name the
// admissible domain outputs so a script can only emit decodable model output.
type EmittedOutput =
  | FindingsOutput
  | PoolOutput
  | VerdictsOutput
  | JudgmentsOutput

// The BugClaim and Judgment paths execute concurrently, so their sessions
// are keyed by cache-group suffix instead of relying on open order.
const emittingSession = (
  output: EmittedOutput,
  forSession?: string,
  usage = usageRow(),
): ScriptedSession => {
  const prompts: Array<ScriptedPrompt> = [
    {
      events: [
        { afterMillis: 0, kind: "message_start" },
        {
          afterMillis: 0,
          kind: "emit",
          args: output,
          valid: true,
        },
        {
          afterMillis: 0,
          kind: "message_end",
          stopReason: "toolUse",
          usage,
        },
      ],
      settles: "after-events",
    },
  ]
  // An unkeyed session is claimed in open order; a keyed one is claimed by
  // matching the invocation's cache-group suffix, so `forSession` is added to
  // the session object only when present.
  return forSession === undefined
    ? { prompts }
    : { prompts, forSession }
}

const VERIFIER_OUTPUT = {
  verdicts: [
    {
      cluster: 1,
      verdict: "CONFIRMED",
      review_priority: "P2",
      evidence: "empty input reaches the added line and throws",
      test_suggestion: {
        tests: ["the alpha input suite"],
        reason: "it exercises empty inputs against the added line",
      },
    },
  ],
} satisfies VerdictsOutput

const JUDGMENT_OUTPUT = {
  decisions: [
    {
      index: 1,
      decision: "keep",
      review_priority: "P2",
      reason: "the call site confirms the name obscures the value's role",
      goodFind: true,
      cleanlyExplained: true,
    },
  ],
} satisfies JudgmentsOutput

const successfulSession = (
  output: FindingsOutput = FINDER_OUTPUT,
  forSession?: string,
  usage = usageRow(),
): ScriptedSession => emittingSession(output, forSession, usage)

const successfulVerifierSession = (): ScriptedSession =>
  emittingSession(VERIFIER_OUTPUT, "-verification")

const successfulJudgmentSession = (): ScriptedSession =>
  emittingSession(JUDGMENT_OUTPUT, "-judgment")

// Concurrent sessions interleave their prompt calls, so prompts are asserted
// by invocation identity, never by global order.
const promptTextsFor = (scripted: Scripted, suffix: string): Array<string> =>
  scripted.prompts
    .filter(({ invocationId }) => invocationId.includes(suffix))
    .map(({ text }) => text)

const inspectionsFor = (scripted: Scripted, suffix: string) =>
  scripted.inspections.filter(
    ({ invocationId }) => invocationId.includes(suffix),
  )

const confinedSession = (
  output: EmittedOutput,
  forSession: string,
  inspect: {
    readonly bash?: ReadonlyArray<string>
    readonly read?: ReadonlyArray<string>
  } = {},
): ScriptedSession => ({
  forSession,
  prompts: [
    {
      events: [
        { afterMillis: 0, kind: "message_start" as const },
        ...(inspect.bash ?? ["pwd"]).map((command) => ({
          afterMillis: 0,
          kind: "tool" as const,
          toolName: "bash" as const,
          args: { command },
        })),
        ...(inspect.read ?? []).map((path) => ({
          afterMillis: 0,
          kind: "tool" as const,
          toolName: "read" as const,
          args: { path },
        })),
        {
          afterMillis: 0,
          kind: "emit" as const,
          args: output,
          valid: true,
        },
        {
          afterMillis: 0,
          kind: "message_end" as const,
          stopReason: "toolUse" as const,
          usage: usageRow(),
        },
      ],
      settles: "after-events" as const,
    },
  ],
})

const successfulScripted = (): Scripted =>
  makeScripted({
    sessions: [
      successfulSession(),
      successfulVerifierSession(),
      successfulJudgmentSession(),
    ],
  })

const runCommand = (
  fixture: Fixture,
  argv: ReadonlyArray<string>,
  scripted: Scripted,
  finderCacheSettle: Effect.Effect<void> = Effect.void,
  github = unusedGitHubLayer,
  linear = unusedLinearLayer,
) => ({
  scripted,
  effect: runGauntlet(argv).pipe(
    Effect.provideService(InvocationDirectory, fixture.repo),
    Effect.provideService(ContentDirectory, fixture.content),
    Effect.provideService(FinderCacheSettle, finderCacheSettle),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
        scriptedLayer(scripted),
        github,
        linear,
      ),
    ),
  ),
})

const review = (fixture: Fixture, scripted = successfulScripted()) =>
  runCommand(
    fixture,
    ["review", "--working-tree", "--lenses", "fixture-review"],
    scripted,
  )

const resume = (
  fixture: Fixture,
  runId: string | undefined,
  scripted = makeScripted({ sessions: [] }),
) =>
  runCommand(
    fixture,
    ["review", "--resume", ...(runId === undefined ? [] : [runId])],
    scripted,
  )

describe("gauntlet review", () => {
  it.effect("lands the frozen plan, completed Finder stage, and presentation", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "untracked.txt"),
        "not in the diff\n",
      )
      const run = review(fixture)

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
      expect(plan.lenses).toHaveLength(1)
      expect(plan.lenses[0]?.name).toBe("fixture-review")
      expect(plan.lenses[0]?.promptText).toBe("fixture lens tail")
      expect(plan.recipeName).toBe("fixture-recipe")
      expect(plan.lenses[0]?.seat).toBe(FIXTURE_SEAT)
      expect(plan.seats.pool).toBe(FIXTURE_SEAT)
      expect(plan.seats.verification).toBe(FIXTURE_SEAT)
      expect(plan.seats.judgment).toBe(FIXTURE_SEAT)
      expect(plan.target._tag).toBe("WorkingTree")
      expect(ReviewTarget.guards.WorkingTree(plan.target)).toBe(true)
      if (!ReviewTarget.guards.WorkingTree(plan.target)) return
      expect(plan.target.changedFiles).toEqual(["alpha.txt"])
      expect(plan.target.diff).toContain("+needle-added-line")
      expect(plan.target.untrackedFiles).toEqual(["untracked.txt"])
      expect(plan.target.warnings).toHaveLength(1)
      expect(plan.target.warnings[0]).toContain("untracked.txt")

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
      expect(run.scripted.configs[0]?.seat).toBe(FIXTURE_SEAT)
      // Every invocation reads the Run's one frozen snapshot worktree, never
      // the developer's live checkout (#56).
      expect(run.scripted.configs[0]?.cwd).not.toBe(plan.target.repoRoot)
      expect(run.scripted.configs[0]?.cwd.endsWith("worktree")).toBe(true)
      for (const config of run.scripted.configs) {
        expect(config.cwd).toBe(run.scripted.configs[0]?.cwd)
        expect(config.tools).toEqual(["read", "bash"])
      }
      const [finderPrompt = ""] = promptTextsFor(run.scripted, "-finders")
      expect(finderPrompt).toMatch(
        /^shared start[\s\S]*shared end\n\nfixture lens tail$/,
      )
      // The finder prompt shows the stable virtual root, never the host
      // snapshot layout (#57).
      expect(finderPrompt).toContain("repo=/repo")
      expect(finderPrompt).not.toContain(
        run.scripted.configs[0]?.cwd ?? "worktree path missing",
      )
      const [verifierPrompt = ""] = promptTextsFor(run.scripted, "-verification")
      expect(verifierPrompt).toContain("### [c1]")
      expect(verifierPrompt).toContain("claimed failure:")
      // The evaluation prompts show the same stable virtual root as the
      // finder prompt, never the host snapshot layout (#58).
      const [judgmentPrompt = ""] = promptTextsFor(run.scripted, "-judgment")
      for (const stagePrompt of [verifierPrompt, judgmentPrompt]) {
        expect(stagePrompt).toContain("repo=/repo")
        expect(stagePrompt).not.toContain(
          run.scripted.configs[0]?.cwd ?? "worktree path missing",
        )
      }
      // A run without a ReviewSpecification carries no absence text in any
      // prompt (issue #73) — nothing announces that no spec was supplied.
      for (const prompt of [finderPrompt, verifierPrompt, judgmentPrompt]) {
        expect(prompt).not.toContain("Review Specification")
        expect(prompt).not.toContain("Caller Addendum")
      }

      const runLog = yield* fs.readFileString(path.join(runDir, "run.log"))
      expect(runLog.length).toBeGreaterThan(0)

      const stdout = (yield* TestConsole.logLines).join("\n")
      const [tally = ""] = stdout.split("\n")
      expect(tally).toContain("1 confirmed · 1 kept · 0 unverified · 0 undecided")
      expect(tally).toContain("working tree @")
      expect(tally).toContain("recipe: fixture-recipe")
      expect(tally).toMatch(/\$0\.15 · \d+s/)
      expect(stdout).toContain("- [P2 confirmed] alpha.txt:2")
      expect(stdout).toContain(
        "- [P2 judgment] alpha.txt — the name hides the value's role",
      )
      expect(stdout).toContain(`dossier.md: ${fixture.runsRoot}`)
      expect(stdout).toContain("dossier.json")
      expect(stdout).not.toContain("gauntlet:")

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain("gauntlet: resolving working-tree review target")
      expect(stderr).toContain("gauntlet: invoking finder fixture-review")
      expect(stderr).toContain(
        "gauntlet: finder fixture-review done — 2 candidates · 0s · $0.05",
      )
      expect(stderr).toContain("gauntlet: Finders finished — 0s")
      expect(stderr).toContain(
        "gauntlet: 1 BugClaim → Verification · 1 Observation → Judgment",
      )
      expect(stderr).toContain("gauntlet: skipping Pool (1 BugClaim)")
      expect(stderr).toContain("gauntlet: invoking Verification bundle 1")
      expect(stderr).toContain(
        "gauntlet: Verification bundle 1 done — 0s · $0.05",
      )
      expect(stderr).toContain(
        "gauntlet: Verification finished — 1 confirmed · 0 refuted · 0 unverified · 0s",
      )
      expect(stderr).toContain("gauntlet: invoking Judgment")
      expect(stderr).toContain("gauntlet: Judgment done — 0s · $0.05")
      expect(stderr).toContain(
        "gauntlet: Judgment finished — 1 kept · 0 dropped · 0 undecided · 0s",
      )
      expect(stderr).toContain("warning — ")
      expect(stderr).toContain("untracked.txt")
      // Digest tally stays on stdout; stage counts use a different shape.
      expect(stderr).not.toMatch(/\d+ confirmed · \d+ kept ·/)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("confines a full review to the ReviewWorkspace and carries a TestSuggestion", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
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

      expect(yield* run.effect).toBe(0)
      expect(run.scripted.configs).toHaveLength(3)

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const runDir = path.join(fixture.runsRoot, runId)
      const entries = yield* fs.readDirectory(runDir)
      expect([...entries].sort()).toEqual([
        "dossier.json",
        "dossier.md",
        "finder-stage.json",
        "plan.json",
        "run.log",
        "workspace-overlay.patch",
      ])

      const dossier = yield* fs.readFileString(path.join(runDir, "dossier.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
      )
      expect(viewDossier(dossier).findings).toEqual(
        expect.arrayContaining([expect.objectContaining({
          tag: "confirmed",
          testSuggestion: {
          tests: ["the alpha input suite"],
          reason: "it exercises empty inputs against the added line",
          bugClaimIds: ["fixture-review/1"],
          },
        })]),
      )
      const report = yield* fs.readFileString(path.join(runDir, "dossier.md"))
      expect(report).toContain(
        "suggested tests: the alpha input suite — it exercises empty inputs against the added line",
      )

      expect(run.scripted.configs).toHaveLength(3)
      const snapshot = run.scripted.configs[0]?.cwd ?? "worktree path missing"
      for (const config of run.scripted.configs) {
        expect(config.tools).toEqual(["read", "bash"])
        expect(config.cwd).toBe(snapshot)
        expect(config.cwd).not.toBe(fixture.repo)
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

      for (const suffix of ["-finders", "-verification", "-judgment"] as const) {
        const [prompt = ""] = promptTextsFor(run.scripted, suffix)
        expect(prompt).toContain(`repo=${REVIEW_WORKSPACE_ROOT}`)
        expect(prompt).not.toContain(snapshot)
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reruns the whole Finder stage when no completed checkpoint exists", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-resume-two.md"),
        "fixture resume two tail\n",
      )
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-resume-three.md"),
        "fixture resume three tail\n",
      )
      const firstScripted = makeScripted({
        sessions: [
          successfulSession({ findings: [] }, "-finders-1"),
          successfulSession({ findings: [] }, "-finders-1"),
          successfulSession({ findings: [] }, "-finders-1"),
        ],
      })
      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        [
          "review",
          "--working-tree",
          "--lenses",
          "fixture-review,fixture-resume-two,fixture-resume-three",
        ],
        firstScripted,
      )
      const firstFiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      const runId = yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(firstFiber)
      yield* fs.remove(
        path.join(fixture.runsRoot, runId, "finder-stage.json"),
      )
      expect(
        yield* fs.exists(
          path.join(fixture.runsRoot, runId, "finder-stage.json"),
        ),
      ).toBe(false)
      const resumed = resume(
        fixture,
        runId,
        makeScripted({
          sessions: [
            successfulSession({ findings: [] }, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-1"),
          ],
        }),
      )
      expect(yield* resumed.effect).toBe(0)
      expect(resumed.scripted.configs).toHaveLength(3)
      // Reruns inside the same Run: the checkpoint returns to its own run dir.
      expect(yield* fs.readDirectory(fixture.runsRoot)).toEqual([runId])
      expect(
        yield* fs.exists(
          path.join(fixture.runsRoot, runId, "finder-stage.json"),
        ),
      ).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes only from a completed Finder stage", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-resume-two.md"),
        "fixture resume two tail\n",
      )
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-resume-three.md"),
        "fixture resume three tail\n",
      )

      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        [
          "review",
          "--working-tree",
          "--lenses",
          "fixture-review,fixture-resume-two,fixture-resume-three",
        ],
        makeScripted({
          sessions: [
            successfulSession({ findings: [] }, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-1"),
          ],
        }),
      )
      const firstFiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      const runId = yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(firstFiber)
      expect(
        yield* fs.exists(
          path.join(fixture.runsRoot, runId, "finder-stage.json"),
        ),
      ).toBe(true)
      const progressBeforeResume = (yield* TestConsole.errorLines).length

      const resumed = resume(
        fixture,
        runId,
        makeScripted({ sessions: [] }),
      )
      expect(yield* resumed.effect).toBe(0)
      expect(resumed.scripted.configs).toEqual([])
      const dossierMarkdown = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "dossier.md"),
      )
      expect(dossierMarkdown).toContain("3 invocations")
      const resumedProgress = (yield* TestConsole.errorLines)
        .slice(progressBeforeResume)
        .join("\n")
      expect(resumedProgress).toContain(
        "reusing completed Finder stage",
      )
      expect(resumedProgress).toContain("finder fixture-review done")
      expect(resumedProgress).toContain("finder fixture-resume-two done")
      expect(resumedProgress).toContain("finder fixture-resume-three done")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("produces an ordinary zero-result Dossier from empty Default Lenses", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* writeSettings(fixture, {
        "default-recipe": "fixture-recipe",
        "default-lenses": [],
        favorites: [],
      })

      const run = runCommand(
        fixture,
        ["review", "--working-tree"],
        makeScripted({ sessions: [] }),
      )
      expect(yield* run.effect).toBe(0)
      expect(run.scripted.configs).toEqual([])

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const runDirectory = path.join(fixture.runsRoot, runId)
      const plan = yield* fs.readFileString(path.join(runDirectory, "plan.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(plan.lenses).toEqual([])
      expect(yield* fs.exists(path.join(runDirectory, "dossier.md"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("skips explicitly selected spec-conformance without a ReviewSpecification while other Finders run", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(
          fixture.content,
          "lenses",
          `${SPEC_CONFORMANCE_LENS_NAME}.md`,
        ),
        "---\nfinder-class: interpretive\n---\nfixture conformance tail\n",
      )
      const run = runCommand(
        fixture,
        [
          "review",
          "--working-tree",
          "--lenses",
          `fixture-review,${SPEC_CONFORMANCE_LENS_NAME}`,
        ],
        makeScripted({
          sessions: [successfulSession({ findings: [] })],
        }),
      )

      expect(yield* run.effect).toBe(0)
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const runDir = path.join(fixture.runsRoot, runId)
      const plan = yield* fs.readFileString(path.join(runDir, "plan.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(plan.lenses.map(({ name }) => name)).toEqual([
        "fixture-review",
        SPEC_CONFORMANCE_LENS_NAME,
      ])
      const finderStage = yield* fs.readFileString(
        path.join(runDir, "finder-stage.json"),
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(FinderStageArtifact)),
        ),
      )
      expect(finderStage.finders.map(({ invocationKey }) => invocationKey)).toEqual([
        "finder-fixture-review",
      ])
      expect(run.scripted.configs).toHaveLength(1)

      const dossier = yield* fs.readFileString(path.join(runDir, "dossier.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
      )
      expect(dossier.coverageGaps).toEqual([])
      const report = yield* fs.readFileString(path.join(runDir, "dossier.md"))
      expect(report).toContain(
        `- Lenses: fixture-review (${FIXTURE_SEAT})`,
      )
      expect(report).not.toContain(
        `${SPEC_CONFORMANCE_LENS_NAME} (${FIXTURE_SEAT})`,
      )
      expect(
        report.split("\n").filter((line) =>
          line ===
            `- Skipped: ${SPEC_CONFORMANCE_LENS_NAME} — no ReviewSpecification`
        ),
      )
        .toHaveLength(1)
      expect(report).toContain("1 invocations")
      expect(report).not.toContain("2 invocations")

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain("gauntlet: invoking finder fixture-review")
      expect(stderr).not.toContain(
        `invoking finder ${SPEC_CONFORMANCE_LENS_NAME}`,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("narrows comma-separated lenses and turns a missing emit into a coverage gap without losing its sibling", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-other.md"),
        "---\nfinder-class: interpretive\n---\nfixture other tail\n",
      )
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: FIXTURE_SEAT,
        "interpretive-finders": "fixture/other-model:low",
      })
      const missingEmitPrompt = {
        events: [
          { afterMillis: 0, kind: "message_start" as const },
          {
            afterMillis: 0,
            kind: "message_end" as const,
            stopReason: "stop" as const,
            usage: usageRow(),
          },
        ],
        settles: "after-events" as const,
      }
      // Distinct seats → two size-1 groups → no cache settle / TestClock.
      const scripted = makeScripted({
        sessions: [
          {
            forSession: "-finders-1",
            prompts: [
              missingEmitPrompt,
              missingEmitPrompt,
              missingEmitPrompt,
            ],
          },
          successfulSession(FINDER_OUTPUT, "-finders-2"),
          successfulVerifierSession(),
          successfulJudgmentSession(),
        ],
      })
      const run = runCommand(
        fixture,
        ["review", "--working-tree", "--lenses", "fixture-review,fixture-other"],
        scripted,
      )
      expect(yield* run.effect).toBe(0)

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const dossier = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "dossier.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
      )
      expect(dossier.coverageGaps).toEqual([
        {
          stage: "finders",
          lens: "fixture-review",
          reason: "finder emitted nothing after 2 corrective turns",
        },
      ])
      const entries = viewDossier(dossier)
      expect([...entries.findings, ...entries.unresolved]).toHaveLength(2)
      expect(run.scripted.configs).toHaveLength(4)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "gauntlet: finder fixture-review done — 0 candidates · 0s · $0.15 · MissingEmit",
      )
      expect(stderr).toContain(
        "gauntlet: coverage gap (fixture-review) — finder emitted nothing after 2 corrective turns",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes the latest incomplete run from its completed Finder stage", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const stageCommitted = yield* Deferred.make<string>()
      const threeBugClaimsAndObservation = {
        findings: [
          {
            file: "alpha.txt",
            line: 2,
            summary: "the added line breaks empty inputs",
            failure_scenario: "an empty input reaches the new line and throws",
          },
          {
            file: "alpha.txt",
            line: 2,
            summary: "the added line drops whitespace",
            failure_scenario: "a padded input reaches the new line and truncates",
          },
          {
            file: "alpha.txt",
            line: 2,
            summary: "the added line rejects unicode",
            failure_scenario: "a unicode input reaches the new line and throws",
          },
          { file: "alpha.txt", summary: "the name hides the value's role" },
        ],
      } satisfies FindingsOutput
      const poolOutput = {
        clusters: [
          {
            indexes: [1, 2, 3],
            summary: "the added line breaks valid inputs",
          },
        ],
      } satisfies PoolOutput
      const first = review(
        fixture,
        makeScripted({
          sessions: [successfulSession(threeBugClaimsAndObservation)],
        }),
      )
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )

      const runId = yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runDir = path.join(fixture.runsRoot, runId)
      expect(yield* fs.exists(path.join(runDir, "plan.json"))).toBe(true)
      expect(
        yield* fs.exists(path.join(runDir, "finder-stage.json")),
      ).toBe(true)
      expect(yield* fs.exists(path.join(runDir, "dossier.json"))).toBe(false)
      expect(yield* fs.exists(path.join(runDir, "dossier.md"))).toBe(false)

      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-review.md"),
        "changed lens content that must not be loaded\n",
      )
      // Recipe edits never change a resumed run: the plan froze the resolved
      // seats at submission (ADR 0005).
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: "fixture/edited-model:high",
      })
      yield* writeSettings(fixture, {
        "default-recipe": "fixture-recipe",
        "default-lenses": [],
        favorites: [],
      })
      const resumed = resume(
        fixture,
        undefined,
        makeScripted({
          sessions: [
            emittingSession(poolOutput, "-pool"),
            successfulVerifierSession(),
            successfulJudgmentSession(),
          ],
        }),
      )
      const exitCode = yield* resumed.effect
      expect(exitCode).toBe(0)
      expect(resumed.scripted.configs).toHaveLength(3)
      for (const config of resumed.scripted.configs) {
        expect(config.seat).toBe(FIXTURE_SEAT)
      }
      expect(resumed.scripted.configs.some(({ invocationId }) =>
        invocationId.endsWith("-pool")
      )).toBe(true)
      expect(resumed.scripted.configs.some(({ invocationId }) =>
        invocationId.includes("-verification-")
      )).toBe(true)
      expect(resumed.scripted.configs.some(({ invocationId }) =>
        invocationId.endsWith("-judgment")
      )).toBe(true)
      expect(resumed.scripted.configs.some(({ invocationId }) =>
        invocationId.includes("-finder-")
      )).toBe(false)

      const dossierText = yield* fs.readFileString(path.join(runDir, "dossier.json"))
      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(
        dossierText,
      )
      const entries = viewDossier(dossier)
      expect([...entries.findings, ...entries.unresolved][0]?.candidate.summary).toBe(
        "the added line breaks empty inputs",
      )
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "reusing completed Finder stage",
      )
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "gauntlet: finder fixture-review done — 4 candidates · 0s · $0.05",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes the frozen working tree after the live checkout moves on", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "stray.txt"),
        "original-untracked\n",
      )
      const stageCommitted = yield* Deferred.make<string>()
      const first = review(fixture)
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      const runId = yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)

      // Tracked edits, untracked content, and the branch all move on, and a
      // later commit leaves the frozen head behind.
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-edit\n",
      )
      yield* fs.writeFileString(
        path.join(fixture.repo, "stray.txt"),
        "edited-untracked\n",
      )
      yield* commitAll(fixture.repo, "live drift")
      yield* runGit(fixture.repo, ["switch", "-c", "some-other-branch"])

      // The destination guard still runs before any paid work: a working-tree
      // run has no PR destination.
      const refused = runCommand(
        fixture,
        ["review", "--resume", runId, "--destination", "pr"],
        makeScripted({ sessions: [] }),
      )
      expect(yield* refused.effect).toBe(1)
      expect(refused.scripted.configs).toHaveLength(0)

      const resumed = resume(
        fixture,
        runId,
        makeScripted({
          sessions: [
            confinedSession(VERIFIER_OUTPUT, "-verification", {
              read: ["alpha.txt", "stray.txt"],
            }),
            successfulJudgmentSession(),
          ],
        }),
      )
      expect(yield* resumed.effect).toBe(0)
      expect(yield* fs.readDirectory(fixture.runsRoot)).toEqual([runId])
      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(`resuming run ${runId}`)
      expect(stderr).toContain("reusing completed Finder stage")

      // /repo is rebuilt from the frozen head commit plus the saved overlay.
      const reads = inspectionsFor(resumed.scripted, "-verification").filter(
        ({ toolName }) => toolName === "read",
      )
      expect(reads[0]?.text).toContain("needle-added-line")
      expect(reads[0]?.text).not.toContain("later-edit")
      expect(reads[1]?.text).toContain("original-untracked")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses to resume without the frozen overlay instead of reviewing something else", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const stageCommitted = yield* Deferred.make<string>()
      const first = review(fixture)
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      const runId = yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const overlay = path.join(
        fixture.runsRoot,
        runId,
        "workspace-overlay.patch",
      )
      yield* fs.remove(overlay)

      const resumed = resume(fixture, runId, successfulScripted())
      expect(yield* resumed.effect).toBe(1)
      expect(resumed.scripted.configs).toHaveLength(0)
      expect(yield* fs.readDirectory(fixture.runsRoot)).toEqual([runId])
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `could not review — the frozen working-tree overlay ${overlay} is missing`,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("shows the caller addendum to interpretive finders, verification, and judgment — never specific finders or pool", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-interpretive.md"),
        "---\nfinder-class: interpretive\n---\nfixture interpretive tail\n",
      )
      // Distinct seats → two size-1 groups → no cache settle / TestClock.
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: FIXTURE_SEAT,
        "interpretive-finders": "fixture/interpretive-model:high",
      })
      // The addendum lives outside the reviewed repository, per the
      // invoking-agent skill's guidance.
      const addendumPath = path.join(fixture.home, "addendum.md")
      const needle = "ADDENDUM-REQUIREMENT: alpha.txt must stay sorted"
      yield* fs.writeFileString(addendumPath, `${needle}\n`)

      // Three BugClaims reach the Pool threshold; one Observation reaches
      // Judgment. The interpretive finder emits nothing — only its prompt
      // matters here.
      const threeBugClaims = {
        findings: [
          ...[1, 2, 3].map((line) => ({
            file: "alpha.txt",
            line,
            summary: `claim ${String(line)}`,
            failure_scenario: `input ${String(line)} breaks`,
          })),
          { file: "alpha.txt", summary: "the name hides the value's role" },
        ],
      } satisfies FindingsOutput
      const poolOutput = {
        clusters: [{ indexes: [1, 2, 3], summary: "one shared defect" }],
      } satisfies PoolOutput
      const run = runCommand(
        fixture,
        [
          "review",
          "--working-tree",
          "--lenses",
          "fixture-review,fixture-interpretive",
          "--spec",
          addendumPath,
        ],
        makeScripted({
          sessions: [
            successfulSession(threeBugClaims, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-2"),
            emittingSession(poolOutput, "-pool"),
            successfulVerifierSession(),
            successfulJudgmentSession(),
          ],
        }),
      )
      expect(yield* run.effect).toBe(0)

      const [standardPrompt = ""] = promptTextsFor(run.scripted, "-finders-1")
      expect(standardPrompt).not.toContain(needle)
      expect(standardPrompt).not.toContain("Review Specification")
      const [poolPrompt = ""] = promptTextsFor(run.scripted, "-pool")
      expect(poolPrompt).not.toContain(needle)
      expect(poolPrompt).not.toContain("Review Specification")

      // Shared context first, specification second, assignment last.
      const [interpretivePrompt = ""] = promptTextsFor(
        run.scripted,
        "-finders-2",
      )
      expect(interpretivePrompt).toMatch(
        new RegExp(
          `shared end\\n\\n## Review Specification\\n\\n[\\s\\S]*### Caller Addendum \\(caller-provided: [\\s\\S]*${needle}[\\s\\S]*\\n\\nfixture interpretive tail$`,
        ),
      )
      const [verifierPrompt = ""] = promptTextsFor(run.scripted, "-verification")
      const [judgmentPrompt = ""] = promptTextsFor(run.scripted, "-judgment")
      expect(verifierPrompt.indexOf(needle)).toBeGreaterThan(
        verifierPrompt.indexOf("needle-added-line"),
      )
      expect(verifierPrompt.indexOf(needle)).toBeLessThan(
        verifierPrompt.indexOf("### [c1]"),
      )
      expect(judgmentPrompt.indexOf(needle)).toBeGreaterThan(
        judgmentPrompt.indexOf("needle-added-line"),
      )
      expect(judgmentPrompt.indexOf(needle)).toBeLessThan(
        judgmentPrompt.indexOf("## Candidates"),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("fails before Run creation on a missing, empty, or resume-combined --spec", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const missing = runCommand(
        fixture,
        ["review", "--working-tree", "--lenses", "fixture-review", "--spec", path.join(fixture.home, "missing.md")],
        makeScripted({ sessions: [] }),
      )
      expect(yield* missing.effect).toBe(1)
      expect(missing.scripted.configs).toHaveLength(0)

      const emptyPath = path.join(fixture.home, "empty.md")
      yield* fs.writeFileString(emptyPath, "  \n\n")
      const empty = runCommand(
        fixture,
        ["review", "--working-tree", "--lenses", "fixture-review", "--spec", emptyPath],
        makeScripted({ sessions: [] }),
      )
      expect(yield* empty.effect).toBe(1)
      expect(empty.scripted.configs).toHaveLength(0)

      const resumed = runCommand(
        fixture,
        ["review", "--resume", "some-run", "--spec", emptyPath],
        makeScripted({ sessions: [] }),
      )
      expect(yield* resumed.effect).toBe(1)

      // No Run directory exists for any of the refused invocations.
      const runIds = (yield* fs.exists(fixture.runsRoot))
        ? yield* fs.readDirectory(fixture.runsRoot)
        : []
      expect(runIds).toHaveLength(0)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "could not review — caller addendum file does not exist",
      )
      expect(stderr).toContain("could not review — caller addendum is empty")
      expect(stderr).toContain(
        "could not review — --spec cannot be combined with --resume; the plan is frozen",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resume replays the frozen addendum after the file is deleted", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const addendumPath = path.join(fixture.home, "addendum.md")
      const needle = "ADDENDUM-REQUIREMENT: alpha.txt must stay sorted"
      yield* fs.writeFileString(addendumPath, `${needle}\n`)

      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        ["review", "--working-tree", "--lenses", "fixture-review", "--spec", addendumPath],
        successfulScripted(),
      )
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)

      // The frozen value is the review input: deleting the file cannot
      // change or block the resumed run.
      yield* fs.remove(addendumPath)

      const resumed = resume(
        fixture,
        undefined,
        makeScripted({
          sessions: [successfulVerifierSession(), successfulJudgmentSession()],
        }),
      )
      expect(yield* resumed.effect).toBe(0)
      const [verifierPrompt = ""] = promptTextsFor(
        resumed.scripted,
        "-verification",
      )
      const [judgmentPrompt = ""] = promptTextsFor(resumed.scripted, "-judgment")
      expect(verifierPrompt).toContain(needle)
      expect(judgmentPrompt).toContain(needle)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes an already-complete run from its artifacts", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const initial = review(fixture)
      expect(yield* initial.effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      // Markdown is the completion signal. The JSON remains an additive machine
      // artifact and does not control resume.
      yield* fs.writeFileString(
        path.join(fixture.runsRoot, runId, "dossier.json"),
        "not valid JSON",
      )
      yield* fs.rename(
        fixture.content,
        path.join(fixture.home, "content-unavailable"),
      )
      yield* fs.rename(
        fixture.repo,
        path.join(fixture.home, "repository-unavailable"),
      )
      const completedResume = resume(fixture, runId)
      expect(yield* completedResume.effect).toBe(0)
      expect(completedResume.scripted.configs).toHaveLength(0)
      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        `run ${runId} is already complete`,
      )
      expect(stderr).toContain(path.join(fixture.runsRoot, runId, "dossier.json"))
      expect(stderr).toContain(path.join(fixture.runsRoot, runId, "dossier.md"))
      expect(yield* fs.exists(path.join(fixture.runsRoot, runId, "dossier.md"))).toBe(
        true,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resume of a PR review keeps the frozen GitHub specification", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      let currentIssues: ReadonlyArray<GitHubClosingIssue> = [
        closingIssue(74, "github source", "FROZEN-SLICE"),
      ]
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () =>
          Effect.succeed(prView(7, headCommit, baseCommit)),
        viewClosingIssues: () => Effect.succeed(currentIssues),
      })
      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        ["review", "--pr", "7", "--lenses", "fixture-review"],
        successfulScripted(),
        Effect.void,
        github,
      )
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)
      currentIssues = [closingIssue(74, "github source", "MUTATED-SLICE")]

      const resumed = runCommand(
        fixture,
        ["review", "--resume"],
        makeScripted({
          sessions: [successfulVerifierSession(), successfulJudgmentSession()],
        }),
        Effect.void,
        github,
      )
      expect(yield* resumed.effect).toBe(0)
      const [verifierPrompt = ""] = promptTextsFor(
        resumed.scripted,
        "-verification",
      )
      expect(verifierPrompt).toContain("FROZEN-SLICE")
      expect(verifierPrompt).not.toContain("MUTATED-SLICE")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes a PR review after the pull request moves out of reach", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      let currentIssues: ReadonlyArray<GitHubClosingIssue> = [
        closingIssue(74, "github source", "FROZEN-SLICE"),
      ]
      let targetCalls = 0
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () => {
          targetCalls += 1
          return Effect.succeed(prView(7, headCommit, baseCommit))
        },
        viewClosingIssues: () => Effect.succeed(currentIssues),
      })
      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        ["review", "--pr", "7", "--lenses", "fixture-review"],
        successfulScripted(),
        Effect.void,
        github,
      )
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      const runId = yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)
      expect(targetCalls).toBe(1)

      // The PR is gone and its closing issues have moved on; the branch has
      // moved too. The resumed Run consults neither.
      currentIssues = [closingIssue(74, "github source", "MUTATED-SLICE")]
      const unavailable = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () => {
          targetCalls += 1
          return Effect.fail(
            new GitHubError({ operation: "view", reason: "pull request 7 is gone" }),
          )
        },
        viewClosingIssues: () => Effect.succeed(currentIssues),
      })
      yield* runGit(fixture.repo, ["switch", "-c", "some-other-branch"])

      const resumed = runCommand(
        fixture,
        ["review", "--resume"],
        makeScripted({
          sessions: [successfulVerifierSession(), successfulJudgmentSession()],
        }),
        Effect.void,
        unavailable,
      )
      expect(yield* resumed.effect).toBe(0)
      expect(targetCalls).toBe(1)
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readDirectory(fixture.runsRoot)).toEqual([runId])
      const [verifierPrompt = ""] = promptTextsFor(
        resumed.scripted,
        "-verification",
      )
      expect(verifierPrompt).toContain("FROZEN-SLICE")
      expect(verifierPrompt).not.toContain("MUTATED-SLICE")
      expect(verifierPrompt).toContain("needle-added-line")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps the frozen Linear specification when the branch changes under a resume", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      yield* runGit(fixture.repo, [
        "switch",
        "-c",
        "john/eng-75-linear-source",
      ])
      const requested: Array<string> = []
      const linear = Linear.Fake({
        viewIssue: (identifier) => {
          requested.push(identifier)
          return Effect.succeed({
            ...linearBranchIssue(),
            id: `id-${identifier}`,
            identifier,
            body: `LINEAR-SLICE-${identifier}`,
          })
        },
      })
      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        ["review", "--working-tree", "--lenses", "fixture-review"],
        successfulScripted(),
        Effect.void,
        unusedGitHubLayer,
        linear,
      )
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)

      yield* runGit(fixture.repo, [
        "switch",
        "-c",
        "john/eng-76-follow-up",
      ])
      const resumed = runCommand(
        fixture,
        ["review", "--resume"],
        makeScripted({
          sessions: [successfulVerifierSession(), successfulJudgmentSession()],
        }),
        Effect.void,
        unusedGitHubLayer,
        linear,
      )
      expect(yield* resumed.effect).toBe(0)
      expect(requested).toEqual(["ENG-75"])
      const resumedPrompts = resumed.scripted.prompts
        .map(({ text }) => text)
        .join("\n")
      expect(resumedPrompts).toContain("LINEAR-SLICE-ENG-75")
      expect(resumedPrompts).not.toContain("LINEAR-SLICE-ENG-76")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("creates no Run for --github-spec without a PR or with resume", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const run = runCommand(
        fixture,
        ["review", "--working-tree", "--github-spec", "--lenses", "fixture-review"],
        successfulScripted(),
      )

      yield* run.effect
      const resumed = runCommand(
        fixture,
        ["review", "--resume", "some-run", "--github-spec"],
        successfulScripted(),
      )
      yield* resumed.effect
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

})

describe("gauntlet review target selection", () => {
  it.effect("requires an explicit target and refuses --pr beside another target flag", () =>
    Effect.gen(function* () {
      const { fixture, trunk } = yield* makeCommitRangeFixture
      const fs = yield* FileSystem.FileSystem

      const bare = runCommand(fixture, ["review"], makeScripted({ sessions: [] }))
      expect(yield* bare.effect).toBe(1)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "name a target: --working-tree, --commits <base>[..<head>], or --pr <number>",
      )

      const both = runCommand(
        fixture,
        ["review", "--pr", "7", "--commits", trunk],
        makeScripted({ sessions: [] }),
      )
      expect(yield* both.effect).toBe(1)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "--pr cannot be combined with --commits or --working-tree",
      )
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes a commit-range review after its refs move", () =>
    Effect.gen(function* () {
      const { fixture, trunk } = yield* makeCommitRangeFixture
      const fs = yield* FileSystem.FileSystem
      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        ["review", "--commits", trunk, "--lenses", "fixture-review"],
        successfulScripted(),
      )
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          FinderStageCheckpoint,
          (runId) =>
            Deferred.succeed(stageCommitted, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )
      const runId = yield* Deferred.await(stageCommitted)
      yield* Fiber.interrupt(fiber)

      // Both submitted refs move out from under the Run; the frozen SHA pair
      // is what it was aimed at, and resume never re-resolves either name.
      yield* runGit(fixture.repo, ["switch", "--detach", "HEAD"])
      yield* runGit(fixture.repo, ["branch", "-D", "feature"])
      yield* runGit(fixture.repo, ["branch", "-m", trunk, "renamed-trunk"])

      const resumed = resume(
        fixture,
        runId,
        makeScripted({
          sessions: [
            confinedSession(VERIFIER_OUTPUT, "-verification", {
              read: ["alpha.txt"],
            }),
            successfulJudgmentSession(),
          ],
        }),
      )
      expect(yield* resumed.effect).toBe(0)
      expect(yield* fs.readDirectory(fixture.runsRoot)).toEqual([runId])
      const read = inspectionsFor(resumed.scripted, "-verification").find(
        ({ toolName }) => toolName === "read",
      )
      expect(read?.text).toContain("needle-added-line")

      // A complete Run is terminal: resume reports its existing artifacts.
      const again = resume(fixture, runId)
      expect(yield* again.effect).toBe(0)
      expect(again.scripted.configs).toEqual([])
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `run ${runId} is already complete`,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
