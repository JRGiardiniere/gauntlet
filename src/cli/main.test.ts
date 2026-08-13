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
import { ReviewPlan } from "../domain/review-plan.ts"
import { unusedGitHubLayer } from "../github/github.ts"
import {
  makeScripted,
  scriptedLayer,
  type Scripted,
  type ScriptedSession,
  usageRow,
} from "../harness/scripted.ts"
import { FindingsOutput } from "../harness/output-contract.ts"
import {
  InvocationArtifact,
  InvocationJournalCheckpoint,
} from "../run/invocation-journal.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import {
  InvocationDirectory,
  runGauntlet,
} from "./main.ts"

interface Fixture {
  readonly repo: string
  readonly home: string
  readonly content: string
  readonly runsRoot: string
  readonly recipesDirectory: string
  readonly settingsFile: string
}

const FIXTURE_SEAT = "fixture/fixture-model:low"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

const writeRecipe = (fixture: Fixture, name: string, recipe: Schema.Json) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const json = yield* encodeJson(recipe)
    yield* fs.writeFileString(
      path.join(fixture.recipesDirectory, `${name}.json`),
      `${json}\n`,
    )
  })

const writeSettings = (fixture: Fixture, settings: Schema.Json) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const json = yield* encodeJson(settings)
    yield* fs.writeFileString(fixture.settingsFile, `${json}\n`)
  })

const SHARED_PROMPT = `shared start
repo={{REPO_ROOT}}
files:
{{CHANGED_FILES}}
{{DIFF_SECTION}}
cap={{MAX_PER_LENS}}
shared end
`

const makeFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { root, repo } = yield* makeGitFixture({ prefix: "gauntlet-cli-test-" })
  const home = path.join(root, "home")
  const content = path.join(root, "content")
  yield* fs.makeDirectory(home, { recursive: true })
  yield* fs.makeDirectory(path.join(content, "lenses"), { recursive: true })
  yield* fs.makeDirectory(path.join(content, "prompts"), { recursive: true })
  yield* fs.writeFileString(
    path.join(content, "lenses", "fixture-review.md"),
    "---\ncategory: correctness\n---\nfixture lens tail\n",
  )
  yield* fs.writeFileString(
    path.join(content, "prompts", "finder-system.md"),
    "fixture finder system prompt\n",
  )
  yield* fs.writeFileString(
    path.join(content, "prompts", "finder-shared-block.md"),
    SHARED_PROMPT,
  )
  yield* fs.writeFileString(
    path.join(content, "prompts", "pool.md"),
    "pool candidates\n{{CANDIDATES}}\n",
  )
  yield* fs.writeFileString(
    path.join(content, "prompts", "verifier.md"),
    "verify claims\n{{SCOPE_BLOCK}}\n{{CLAIMS}}\n",
  )
  yield* fs.writeFileString(
    path.join(content, "prompts", "stage-scope-block.md"),
    "repo={{REPO_ROOT}}\nfiles={{CHANGED_FILES}}\n{{DIFF_SECTION}}\nintent={{INTENT_SECTION}}\n",
  )
  const fixture: Fixture = {
    repo,
    home,
    content,
    runsRoot: path.join(home, ".gauntlet", "runs"),
    recipesDirectory: path.join(home, ".gauntlet", "recipes"),
    settingsFile: path.join(home, ".gauntlet", "settings.json"),
  }
  yield* fs.makeDirectory(fixture.recipesDirectory, { recursive: true })
  yield* writeRecipe(fixture, "fixture-recipe", { default: FIXTURE_SEAT })
  yield* writeSettings(fixture, {
    "default-recipe": "fixture-recipe",
    favorites: [],
  })
  return fixture
})

const makeDirtyRepo = Effect.gen(function* () {
  const fixture = yield* makeFixture
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.writeFileString(path.join(fixture.repo, "alpha.txt"), "first line\n")
  yield* commitAll(fixture.repo, "initial")
  yield* fs.writeFileString(
    path.join(fixture.repo, "alpha.txt"),
    "first line\nneedle-added-line\n",
  )
  return fixture
})

const FinderInvocationArtifact = InvocationArtifact(FindingsOutput)

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
}

// The BugClaim and Judgment paths execute concurrently, so their sessions
// are keyed by session-id suffix instead of relying on open order.
const emittingSession = (
  output: unknown,
  forSession?: string,
): ScriptedSession => ({
  ...(forSession === undefined ? {} : { forSession }),
  prompts: [
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
          usage: usageRow(),
        },
      ],
      settles: "after-events",
    },
  ],
})

const successfulSession = (
  output: FindingsOutput = FINDER_OUTPUT,
  forSession?: string,
): ScriptedSession => emittingSession(output, forSession)

const successfulVerifierSession = (): ScriptedSession =>
  emittingSession({
    verdicts: [
      {
        cluster: 1,
        verdict: "CONFIRMED",
        severity: "P2",
        evidence: "empty input reaches the added line and throws",
      },
    ],
  }, "-verification")

const successfulJudgmentSession = (): ScriptedSession =>
  emittingSession({
    decisions: [
      {
        index: 1,
        decision: "keep",
        tier: "P2",
        reason: "the call site confirms the name obscures the value's role",
        goodFind: true,
        cleanlyExplained: true,
      },
    ],
  }, "-judgment")

// Concurrent sessions interleave their prompt calls, so prompts are asserted
// by the session id they were recorded against, never by global order.
const promptTextsFor = (scripted: Scripted, suffix: string): Array<string> =>
  scripted.prompts
    .filter(({ sessionId }) => sessionId?.includes(suffix) ?? false)
    .map(({ text }) => text)

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
) => ({
  scripted,
  effect: runGauntlet(argv).pipe(
    Effect.provideService(InvocationDirectory, fixture.repo),
    Effect.provideService(ContentDirectory, fixture.content),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
        scriptedLayer(scripted),
        unusedGitHubLayer,
      ),
    ),
  ),
})

const review = (fixture: Fixture, scripted = successfulScripted()) =>
  runCommand(
    fixture,
    ["review", "--lenses", "fixture-review"],
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
  it.effect("lands the frozen plan, invocation journal, candidates, and presentation", () =>
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
        "journal",
        "plan.json",
        "run.log",
      ])

      const planText = yield* fs.readFileString(path.join(runDir, "plan.json"))
      const plan = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))(
        planText,
      )
      expect(plan.runId).toBe(runIds[0])
      expect(plan.lenses).toHaveLength(1)
      expect(plan.lenses[0]?.name).toBe("fixture-review")
      expect(plan.lenses[0]?.promptText).toBe("fixture lens tail")
      expect(plan.lenses[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.recipeName).toBe("fixture-recipe")
      expect(plan.lenses[0]?.seat).toBe(FIXTURE_SEAT)
      expect(plan.seats.pool).toBe(FIXTURE_SEAT)
      expect(plan.seats.verification).toBe(FIXTURE_SEAT)
      expect(plan.seats.judgment).toBe(FIXTURE_SEAT)
      expect(plan.target._tag).toBe("WorkingTree")
      expect(plan.target.changedFiles).toEqual(["alpha.txt"])
      expect(plan.target.diff).toContain("+needle-added-line")
      expect(plan.target.warnings).toHaveLength(1)
      expect(plan.target.warnings[0]).toContain("untracked.txt")

      const journalEntries = yield* fs.readDirectory(path.join(runDir, "journal"))
      expect(journalEntries.sort()).toEqual([
        "finder-fixture-review.json",
        "judgment.json",
        "verification-bundle-1.json",
      ])
      const journalText = yield* fs.readFileString(
        path.join(runDir, "journal", "finder-fixture-review.json"),
      )
      const journal = yield* Schema.decodeEffect(
        Schema.fromJsonString(FinderInvocationArtifact),
      )(journalText)
      expect(journal.runId).toBe(plan.runId)
      expect(journal.outcome.termination._tag).toBe("Completed")
      expect(journal.outcome.output).toEqual(FINDER_OUTPUT)
      expect(journal.outcome.usage.rawRows).toHaveLength(1)

      const dossierText = yield* fs.readFileString(path.join(runDir, "dossier.json"))
      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(
        dossierText,
      )
      expect(dossier.runId).toBe(plan.runId)
      expect(dossier.bugClaims).toHaveLength(1)
      expect(dossier.bugClaims[0]?.candidate._tag).toBe("BugClaim")
      expect(dossier.bugClaims[0]?.candidate.id).toBe("fixture-review/1")
      expect(dossier.bugClaims[0]?.verdict).toEqual({
        _tag: "Confirmed",
        severity: "P2",
        evidence: "empty input reaches the added line and throws",
      })
      expect(dossier.observations).toHaveLength(1)
      expect(dossier.observations[0]?.candidate._tag).toBe("Observation")
      expect(dossier.observations[0]?.candidate.id).toBe("fixture-review/2")
      expect(dossier.observations[0]?.judgment).toMatchObject({
        _tag: "Kept",
        tier: "P2",
        goodFind: true,
        cleanlyExplained: true,
      })
      expect(dossier.coverageGaps).toEqual([])

      const report = yield* fs.readFileString(path.join(runDir, "dossier.md"))
      expect(report).toContain(`# Gauntlet review ${plan.runId}`)
      expect(report).toContain("the added line breaks empty inputs")
      expect(report).toContain("the name hides the value's role")
      expect(report).toContain("3 invocations")
      expect(report).toContain(
        "Recipe: fixture-recipe (pool: fixture/fixture-model:low, verification: fixture/fixture-model:low, judgment: fixture/fixture-model:low)",
      )
      expect(report).toContain("- Warnings: ")
      expect(report).toContain("untracked.txt")

      // The diff is stored exactly once, in the plan (ADR 0006).
      const runRecordText = planText + journalText + dossierText + report
      expect(runRecordText.split("needle-added-line").length - 1).toBe(1)

      expect(run.scripted.configs).toHaveLength(3)
      expect(run.scripted.configs[0]?.seat).toBe(FIXTURE_SEAT)
      expect(run.scripted.configs[0]?.cwd).toBe(plan.target.repoRoot)
      for (const config of run.scripted.configs) {
        expect(config.tools).toEqual(["read", "bash"])
      }
      expect(promptTextsFor(run.scripted, "-finders")[0]).toMatch(
        /^shared start[\s\S]*shared end\n\nfixture lens tail$/,
      )
      const [verifierPrompt] = promptTextsFor(run.scripted, "-verification")
      expect(verifierPrompt).toContain("### [c1]")
      expect(verifierPrompt).toContain("claimed failure:")

      const runLog = yield* fs.readFileString(path.join(runDir, "run.log"))
      expect(runLog.length).toBeGreaterThan(0)

      const stdout = (yield* TestConsole.logLines).join("\n")
      const [tally = ""] = stdout.split("\n")
      expect(tally).toContain("1 confirmed · 1 kept · 0 unverified · 0 undecided")
      expect(tally).toContain("working tree @")
      expect(tally).toContain("recipe: fixture-recipe")
      expect(tally).toMatch(/\$0\.15 · \d+s/)
      expect(stdout).toContain("- [P2] alpha.txt:2")
      expect(stdout).toContain(
        "- [P2] alpha.txt — the name hides the value's role",
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

  it.effect("loads the full shipped and project-local catalog, skips needs-spec lenses, and freezes seats", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-spec.md"),
        "---\nneeds-spec: true\n---\nfixture spec tail\n",
      )
      const projectLenses = path.join(fixture.repo, ".gauntlet", "lenses")
      yield* fs.makeDirectory(projectLenses, { recursive: true })
      yield* fs.writeFileString(
        path.join(projectLenses, "fixture-local.md"),
        "---\nfinder-class: deep\n---\nfixture local tail\n",
      )
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: FIXTURE_SEAT,
        "deep-finders": "fixture/local-model:medium",
      })

      // One standard + one deep seat keeps each model group size-1, so the
      // cache settle never fires and this stays free of TestClock.
      const run = runCommand(
        fixture,
        ["review"],
        makeScripted({
          sessions: [
            successfulSession({ findings: [] }, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-2"),
          ],
        }),
      )
      expect(yield* run.effect).toBe(0)

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(ReviewPlan)),
        ),
      )
      expect(plan.lenses.map((lens) => lens.name)).toEqual([
        "fixture-review",
        "fixture-local",
      ])
      expect(plan.lenses.some((lens) => lens.name === "fixture-spec")).toBe(
        false,
      )
      const seatByLens = new Map(
        plan.lenses.map((lens) => [lens.name, lens.seat]),
      )
      expect(seatByLens.get("fixture-review")).toBe(FIXTURE_SEAT)
      expect(seatByLens.get("fixture-local")).toBe("fixture/local-model:medium")

      const journals = yield* fs.readDirectory(
        path.join(fixture.runsRoot, runId, "journal"),
      )
      expect(journals.sort()).toEqual([
        "finder-fixture-local.json",
        "finder-fixture-review.json",
      ])

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "gauntlet: 0 BugClaims → Verification · 0 Observations → Judgment",
      )
      expect(stderr).toContain("gauntlet: skipping Pool (0 BugClaims)")
      expect(stderr).toContain("gauntlet: skipping Verification (0 BugClaims)")
      expect(stderr).toContain("gauntlet: skipping Judgment (0 Observations)")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("freezes seats from a positional recipe for every stage and both finder classes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-deep.md"),
        "---\nfinder-class: deep\n---\nfixture deep tail\n",
      )
      // fixture-recipe stays the configured default; naming fixture-full
      // positionally must win (selection precedence, ADR 0005).
      yield* writeRecipe(fixture, "fixture-full", {
        default: "fixture/default-model:low",
        finders: "fixture/finder-model:low",
        "deep-finders": "fixture/deep-model:high",
        pool: "fixture/pool-model:low",
        verification: "fixture/verify-model:low",
        judgment: "fixture/judge-model:low",
      })
      const run = runCommand(
        fixture,
        ["review", "fixture-full", "--lenses", "fixture-review,fixture-deep"],
        makeScripted({
          sessions: [
            successfulSession({ findings: [] }, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-2"),
          ],
        }),
      )
      expect(yield* run.effect).toBe(0)

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(ReviewPlan)),
        ),
      )
      expect(plan.recipeName).toBe("fixture-full")
      expect(plan.seats).toEqual({
        pool: "fixture/pool-model:low",
        verification: "fixture/verify-model:low",
        judgment: "fixture/judge-model:low",
      })
      const seatByLens = new Map(
        plan.lenses.map((lens) => [lens.name, lens.seat]),
      )
      expect(seatByLens.get("fixture-review")).toBe("fixture/finder-model:low")
      expect(seatByLens.get("fixture-deep")).toBe("fixture/deep-model:high")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("narrows comma-separated lenses and turns a missing emit into a coverage gap without losing its sibling", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-other.md"),
        "---\nfinder-class: deep\n---\nfixture other tail\n",
      )
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: FIXTURE_SEAT,
        "deep-finders": "fixture/other-model:low",
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
        ["review", "--lenses", "fixture-review,fixture-other"],
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
      expect(dossier.bugClaims).toHaveLength(1)
      expect(dossier.observations).toHaveLength(1)
      expect(run.scripted.configs).toHaveLength(4)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "gauntlet: finder fixture-review done — 0 candidates · 0s · $0.15 · MissingEmit",
      )
      expect(stderr).toContain(
        "gauntlet: coverage gap (fixture-review) — finder emitted nothing after 2 corrective turns",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes the latest incomplete run without repaying its journaled finder", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const journaled = yield* Deferred.make<string>()
      const first = review(fixture)
      const fiber = yield* first.effect.pipe(
        Effect.provideService(
          InvocationJournalCheckpoint,
          (runId) =>
            Deferred.succeed(journaled, runId).pipe(
              Effect.andThen(Effect.never),
            ),
        ),
        Effect.forkChild,
      )

      const runId = yield* Deferred.await(journaled)
      yield* Fiber.interrupt(fiber)

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const runDir = path.join(fixture.runsRoot, runId)
      expect(yield* fs.exists(path.join(runDir, "plan.json"))).toBe(true)
      expect(
        yield* fs.exists(
          path.join(runDir, "journal", "finder-fixture-review.json"),
        ),
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
      const resumed = resume(
        fixture,
        undefined,
        makeScripted({
          sessions: [successfulVerifierSession(), successfulJudgmentSession()],
        }),
      )
      const exitCode = yield* resumed.effect
      expect(exitCode).toBe(0)
      expect(resumed.scripted.configs).toHaveLength(2)
      for (const config of resumed.scripted.configs) {
        expect(config.seat).toBe(FIXTURE_SEAT)
      }

      const dossierText = yield* fs.readFileString(path.join(runDir, "dossier.json"))
      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(
        dossierText,
      )
      expect(dossier.bugClaims[0]?.candidate.summary).toBe(
        "the added line breaks empty inputs",
      )
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "reusing finder fixture-review from journal",
      )
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "gauntlet: finder fixture-review done — 2 candidates · 0s · $0.05",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses to pay a missing invocation after the working tree changes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const initial = review(fixture)
      expect(yield* initial.effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const journalPath = path.join(
        fixture.runsRoot,
        runId,
        "journal",
        "finder-fixture-review.json",
      )
      yield* fs.rename(journalPath, `${journalPath}.missing`)
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-edit\n",
      )

      const driftedResume = resume(fixture, runId, successfulScripted())
      expect(yield* driftedResume.effect).toBe(1)
      expect(driftedResume.scripted.configs).toHaveLength(0)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "working tree changed after run",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resumes an already-complete run without invoking its finder", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const initial = review(fixture)
      expect(yield* initial.effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      yield* fs.rename(
        path.join(fixture.content, "prompts"),
        path.join(fixture.content, "prompts-unavailable"),
      )
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-edit\n",
      )
      const completedResume = resume(fixture, runId)
      expect(yield* completedResume.effect).toBe(0)
      expect(completedResume.scripted.configs).toHaveLength(0)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `resuming run ${runId}`,
      )
      expect(yield* fs.exists(path.join(fixture.runsRoot, runId, "dossier.md"))).toBe(
        true,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
