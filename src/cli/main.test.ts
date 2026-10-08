import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { ContentDirectory } from "../content/lens.ts"
import { Dossier } from "../domain/dossier.ts"
import { SPEC_CONFORMANCE_LENS_NAME } from "../domain/finder-selection.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import { unusedGitHubLayer } from "../github/github.ts"
import { unusedLinearLayer } from "../linear/linear.ts"
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
} from "../run/finder-execution.ts"
import type { JudgmentsOutput } from "../stages/judgment/output-contract.ts"
import { viewDossier } from "../render/dossier-view.ts"
import { type RunMilestone, RunMilestones } from "../run/run-milestones.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import {
  FIXTURE_SEAT,
  makeCommitRangeFixture,
  makeDirtyRepo,
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

// The finder shared block rides in the system prompt; the user message is
// only the lens tail.
const systemPromptsFor = (scripted: Scripted, suffix: string): Array<string> =>
  scripted.prompts
    .filter(({ invocationId }) => invocationId.includes(suffix))
    .map(({ openIndex }) => scripted.configs[openIndex - 1]?.systemPrompt ?? "")

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

describe("gauntlet review", () => {
  it.effect("runs a confined review through persisted artifacts and presentation", () =>
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

  it.effect("produces an ordinary zero-result Dossier from empty Default Lenses, freezing --related-files", () =>
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
        ["review", "--working-tree", "--related-files"],
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
      expect(plan.relatedFiles).toBe(true)
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
        "gauntlet: finder fixture-review done — 0 candidates · 0s · MissingEmit\n",
      )
      // The cache share is for run.log alone.
      expect(stderr).not.toContain("cache 42%")
      const runLog = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "run.log"),
      )
      expect(runLog).toContain(
        "finder fixture-review done — 0 candidates · 0s · MissingEmit · cache 42%",
      )
      expect(stderr).toContain(
        "gauntlet: coverage gap (fixture-review) — finder emitted nothing after 2 corrective turns",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps a failed Judgment's provider diagnostics in run.log", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const failedJudgment: ScriptedSession = {
        forSession: "-judgment",
        prompts: [
          {
            events: [
              { afterMillis: 0, kind: "message_start" },
              {
                afterMillis: 0,
                kind: "message_end",
                stopReason: "error",
                errorMessage: "529 overloaded: fixture provider body",
                usage: usageRow(),
              },
            ],
            settles: "after-events",
          },
        ],
      }
      const run = review(
        fixture,
        makeScripted({
          sessions: [
            successfulSession(),
            successfulVerifierSession(),
            failedJudgment,
          ],
        }),
      )
      expect(yield* run.effect).toBe(0)

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const runLog = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "run.log"),
      )
      expect(runLog).toContain("529 overloaded: fixture provider body")
      // The user-facing gap keeps its short reason.
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "gauntlet: coverage gap — judgment provider failed",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reports the Run's milestones as data beside its progress lines", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const reported: Array<RunMilestone> = []
      const run = review(fixture)
      expect(
        yield* run.effect.pipe(
          Effect.provideService(RunMilestones, (milestone) =>
            Effect.sync(() => {
              reported.push(milestone)
            })),
        ),
      ).toBe(0)

      expect(reported.map((milestone) => milestone._tag)).toEqual([
        "Started",
        "FindersFinished",
        "Routed",
        "Reviewed",
      ])
      const [started, , routed, reviewed] = reported
      expect(started).toMatchObject({ lenses: ["fixture-review"] })
      expect(routed).toMatchObject({ bugClaims: 1, observations: 1 })
      expect(reviewed).toMatchObject({
        entries: [
          { tag: "confirmed", reviewPriority: "P2" },
          { tag: "judgment", reviewPriority: "P2" },
        ],
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reports a refusal as the line it rendered, a settings failure included", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      yield* fs.writeFileString(fixture.settingsFile, "{ not json\n")
      const reported: Array<RunMilestone> = []
      const run = review(fixture)
      expect(
        yield* run.effect.pipe(
          Effect.provideService(RunMilestones, (milestone) =>
            Effect.sync(() => {
              reported.push(milestone)
            })),
        ),
      ).toBe(1)

      const [refused] = reported
      expect(refused?._tag).toBe("Refused")
      if (refused?._tag !== "Refused") return
      expect(refused.message).toContain(fixture.settingsFile)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `gauntlet: ${refused.message}`,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("renders a filesystem failure as its operation, path and reason", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      // A file where the runs root belongs: the run directory cannot be made.
      yield* fs.writeFileString(fixture.runsRoot, "not a directory\n")

      const run = review(fixture)
      expect(yield* run.effect).toBe(1)
      expect(run.scripted.configs).toHaveLength(0)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `gauntlet: could not review — FileSystem.makeDirectory failed on ${fixture.runsRoot}: AlreadyExists (EEXIST)`,
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

      const [standardSystemPrompt = ""] = systemPromptsFor(run.scripted, "-finders-1")
      expect(standardSystemPrompt).not.toContain(needle)
      expect(standardSystemPrompt).not.toContain("Review Specification")
      const [poolPrompt = ""] = promptTextsFor(run.scripted, "-pool")
      expect(poolPrompt).not.toContain(needle)
      expect(poolPrompt).not.toContain("Review Specification")

      // Shared context then specification in the system prompt; the
      // assignment alone in the user message.
      const [interpretiveSystemPrompt = ""] = systemPromptsFor(
        run.scripted,
        "-finders-2",
      )
      expect(interpretiveSystemPrompt).toMatch(
        new RegExp(
          `shared end\\n\\n## Review Specification\\n\\n[\\s\\S]*### Caller Addendum \\(caller-provided: [\\s\\S]*${needle}[\\s\\S]*$`,
        ),
      )
      const [interpretivePrompt = ""] = promptTextsFor(run.scripted, "-finders-2")
      expect(interpretivePrompt).toBe("## Your lens\n\nfixture interpretive tail")
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

  it.effect("fails before paid work on a missing or empty --spec", () =>
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
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a GitHub-only specification for a working-tree review before paid work", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const run = runCommand(
        fixture,
        ["review", "--working-tree", "--github-spec", "--lenses", "fixture-review"],
        successfulScripted(),
      )

      expect(yield* run.effect).toBe(1)
      expect(run.scripted.configs).toEqual([])
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

})
