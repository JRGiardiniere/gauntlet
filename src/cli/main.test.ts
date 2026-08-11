import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ContentDirectory } from "../content/lens.ts"
import { Dossier } from "../domain/dossier.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import {
  makeScripted,
  scriptedLayer,
  type Scripted,
  usageRow,
} from "../harness/scripted.ts"
import { FinderInvocationArtifact } from "../run/invocation-journal.ts"
import { InvocationJournalCheckpoint } from "../run/review-executor.ts"
import {
  InvocationDirectory,
  runGauntlet,
} from "./main.ts"

const git = (cwd: string, ...args: Array<string>) => {
  execFileSync("git", args, { cwd, stdio: "pipe" })
}

const commitAll = (repo: string, message: string) => {
  git(repo, "add", "--all")
  git(
    repo,
    "-c",
    "user.name=gauntlet-test",
    "-c",
    "user.email=gauntlet-test@example.invalid",
    "commit",
    "--message",
    message,
  )
}

interface Fixture {
  readonly repo: string
  readonly home: string
  readonly content: string
  readonly runsRoot: string
}

const SHARED_PROMPT = `shared start
repo={{REPO_ROOT}}
files:
{{CHANGED_FILES}}
diff:
{{DIFF}}
cap={{MAX_PER_LENS}}
shared end
`

const makeFixture = (): Fixture => {
  const root = mkdtempSync(join(tmpdir(), "gauntlet-cli-test-"))
  const repo = join(root, "repo")
  const home = join(root, "home")
  const content = join(root, "content")
  mkdirSync(repo, { recursive: true })
  mkdirSync(home, { recursive: true })
  mkdirSync(join(content, "lenses"), { recursive: true })
  mkdirSync(join(content, "prompts"), { recursive: true })
  writeFileSync(
    join(content, "lenses", "fixture-review.md"),
    "---\ncategory: correctness\n---\nfixture lens tail\n",
  )
  writeFileSync(
    join(content, "prompts", "finder-system.md"),
    "fixture finder system prompt\n",
  )
  writeFileSync(
    join(content, "prompts", "finder-shared-block.md"),
    SHARED_PROMPT,
  )
  git(repo, "init")
  return {
    repo,
    home,
    content,
    runsRoot: join(home, ".gauntlet", "runs"),
  }
}

const makeDirtyRepo = (): Fixture => {
  const fixture = makeFixture()
  writeFileSync(join(fixture.repo, "alpha.txt"), "first line\n")
  commitAll(fixture.repo, "initial")
  writeFileSync(join(fixture.repo, "alpha.txt"), "first line\nneedle-added-line\n")
  return fixture
}

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

const successfulScripted = (): Scripted =>
  makeScripted({
    sessions: [
      {
        prompts: [
          {
            events: [
              { afterMillis: 0, kind: "message_start" },
              {
                afterMillis: 0,
                kind: "emit",
                args: FINDER_OUTPUT,
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
      },
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

describe("gauntlet review — single-lens tracer", () => {
  it.effect("lands the frozen plan, invocation journal, candidates, and presentation", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const run = review(fixture)

      const exitCode = yield* run.effect
      expect(exitCode).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const runIds = yield* fs.readDirectory(fixture.runsRoot)
      expect(runIds).toHaveLength(1)
      const runDir = join(fixture.runsRoot, runIds[0] ?? "")

      const entries = yield* fs.readDirectory(runDir)
      expect([...entries].sort()).toEqual([
        "dossier.json",
        "journal",
        "plan.json",
        "report.md",
        "run.log",
      ])

      const planText = yield* fs.readFileString(join(runDir, "plan.json"))
      const plan = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))(
        planText,
      )
      expect(plan.runId).toBe(runIds[0])
      expect(plan.lenses).toHaveLength(1)
      expect(plan.lenses[0]?.name).toBe("fixture-review")
      expect(plan.lenses[0]?.promptText).toBe("fixture lens tail")
      expect(plan.lenses[0]?.contentHash).toMatch(/^[a-f0-9]{64}$/)
      expect(plan.seats.finders).toBe("openai-codex/gpt-5.6-luna:low")
      expect(plan.target._tag).toBe("WorkingTree")
      expect(plan.target.changedFiles).toEqual(["alpha.txt"])
      expect(plan.target.diff).toContain("+needle-added-line")

      const journalEntries = yield* fs.readDirectory(join(runDir, "journal"))
      expect(journalEntries).toEqual(["finder-fixture-review.json"])
      const journalText = yield* fs.readFileString(
        join(runDir, "journal", "finder-fixture-review.json"),
      )
      const journal = yield* Schema.decodeEffect(
        Schema.fromJsonString(FinderInvocationArtifact),
      )(journalText)
      expect(journal.runId).toBe(plan.runId)
      expect(journal.outcome.termination._tag).toBe("Completed")
      expect(journal.outcome.output).toEqual(FINDER_OUTPUT)
      expect(journal.outcome.usage.rawRows).toHaveLength(1)

      const dossierText = yield* fs.readFileString(join(runDir, "dossier.json"))
      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(
        dossierText,
      )
      expect(dossier.runId).toBe(plan.runId)
      expect(dossier.bugClaims).toHaveLength(1)
      expect(dossier.bugClaims[0]?.candidate._tag).toBe("BugClaim")
      expect(dossier.bugClaims[0]?.candidate.id).toBe("fixture-review/1")
      expect(dossier.observations).toHaveLength(1)
      expect(dossier.observations[0]?.candidate._tag).toBe("Observation")
      expect(dossier.observations[0]?.candidate.id).toBe("fixture-review/2")
      expect(dossier.coverageGaps).toEqual([])

      const report = yield* fs.readFileString(join(runDir, "report.md"))
      expect(report).toContain(`# Gauntlet review ${plan.runId}`)
      expect(report).toContain("the added line breaks empty inputs")
      expect(report).toContain("the name hides the value's role")
      expect(report).toContain("1 invocations")
      expect(report).toContain(
        "Recipe: none (finders: openai-codex/gpt-5.6-luna:low)",
      )

      // The diff is stored exactly once, in the plan (ADR 0006).
      const runRecordText = planText + journalText + dossierText + report
      expect(runRecordText.split("needle-added-line").length - 1).toBe(1)

      expect(run.scripted.configs).toHaveLength(1)
      expect(run.scripted.configs[0]?.cwd).toBe(plan.target.repoRoot)
      expect(run.scripted.configs[0]?.tools).toEqual(["read", "bash"])
      expect(run.scripted.promptTexts[0]).toMatch(
        /^shared start[\s\S]*shared end\n\nfixture lens tail$/,
      )

      const runLog = yield* fs.readFileString(join(runDir, "run.log"))
      expect(runLog.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("prints a bounded candidate digest on stdout and narrates on stderr", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()

      const exitCode = yield* review(fixture).effect
      expect(exitCode).toBe(0)

      const stdout = (yield* TestConsole.logLines).join("\n")
      const [tally = ""] = stdout.split("\n")
      expect(tally).toContain("0 confirmed · 0 kept · 1 unverified · 1 undecided")
      expect(tally).toContain("working tree @")
      expect(tally).toContain("recipe: none")
      expect(tally).toMatch(/\$0\.05 · \d+s/)
      expect(stdout).toContain("- [unverified] alpha.txt:2")
      expect(stdout).toContain("- [undecided] alpha.txt")
      expect(stdout).toContain(`report: ${fixture.runsRoot}`)
      expect(stdout).toContain("dossier.json")
      expect(stdout).not.toContain("gauntlet:")

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain("gauntlet: resolving working-tree review target")
      expect(stderr).toContain("gauntlet: invoking finder fixture-review")
      expect(stderr).not.toContain("confirmed ·")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("records untracked files as a scope-degradation warning", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      writeFileSync(join(fixture.repo, "untracked.txt"), "not in the diff\n")

      const exitCode = yield* review(fixture).effect
      expect(exitCode).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const runIds = yield* fs.readDirectory(fixture.runsRoot)
      const planText = yield* fs.readFileString(
        join(fixture.runsRoot, runIds[0] ?? "", "plan.json"),
      )
      const plan = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))(
        planText,
      )
      expect(plan.target.warnings).toHaveLength(1)
      expect(plan.target.warnings[0]).toContain("untracked.txt")

      const report = yield* fs.readFileString(
        join(fixture.runsRoot, runIds[0] ?? "", "report.md"),
      )
      expect(report).toContain("- Warnings: ")
      expect(report).toContain("untracked.txt")
      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain("warning — ")
      expect(stderr).toContain("untracked.txt")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("resumes the latest incomplete run without repaying its journaled finder", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
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
      const runDir = join(fixture.runsRoot, runId)
      expect(yield* fs.exists(join(runDir, "plan.json"))).toBe(true)
      expect(
        yield* fs.exists(
          join(runDir, "journal", "finder-fixture-review.json"),
        ),
      ).toBe(true)
      expect(yield* fs.exists(join(runDir, "dossier.json"))).toBe(false)
      expect(yield* fs.exists(join(runDir, "report.md"))).toBe(false)

      // Resume must use the frozen lens tail rather than reopening mutable
      // content after the run has started.
      writeFileSync(
        join(fixture.content, "lenses", "fixture-review.md"),
        "changed lens content that must not be loaded\n",
      )
      const resumed = resume(fixture, undefined)
      const exitCode = yield* resumed.effect
      expect(exitCode).toBe(0)
      expect(resumed.scripted.configs).toHaveLength(0)

      const dossierText = yield* fs.readFileString(join(runDir, "dossier.json"))
      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(
        dossierText,
      )
      expect(dossier.bugClaims[0]?.candidate.summary).toBe(
        "the added line breaks empty inputs",
      )
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "reusing finder fixture-review from journal",
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("re-invokes corrupt and foreign journal files instead of adopting them", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const initial = review(fixture)
      expect(yield* initial.effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const journalPath = join(
        fixture.runsRoot,
        runId,
        "journal",
        "finder-fixture-review.json",
      )
      yield* fs.writeFileString(journalPath, "{not valid json\n")

      const corruptResume = resume(fixture, runId, successfulScripted())
      expect(yield* corruptResume.effect).toBe(0)
      expect(corruptResume.scripted.configs).toHaveLength(1)

      const repairedText = yield* fs.readFileString(journalPath)
      const repaired = yield* Schema.decodeEffect(
        Schema.fromJsonString(FinderInvocationArtifact),
      )(repairedText)
      const foreignText = yield* Schema.encodeEffect(
        Schema.fromJsonString(FinderInvocationArtifact),
      )({ ...repaired, runId: "foreign-run" })
      yield* fs.writeFileString(
        journalPath,
        `${foreignText}\n`,
      )

      const foreignResume = resume(fixture, runId, successfulScripted())
      expect(yield* foreignResume.effect).toBe(0)
      expect(foreignResume.scripted.configs).toHaveLength(1)

      const finalText = yield* fs.readFileString(journalPath)
      const finalArtifact = yield* Schema.decodeEffect(
        Schema.fromJsonString(FinderInvocationArtifact),
      )(finalText)
      expect(finalArtifact.runId).toBe(runId)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("refuses to pay a missing invocation after the working tree changes", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const initial = review(fixture)
      expect(yield* initial.effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const journalPath = join(
        fixture.runsRoot,
        runId,
        "journal",
        "finder-fixture-review.json",
      )
      renameSync(journalPath, `${journalPath}.missing`)
      writeFileSync(
        join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-edit\n",
      )

      const driftedResume = resume(fixture, runId, successfulScripted())
      expect(yield* driftedResume.effect).toBe(1)
      expect(driftedResume.scripted.configs).toHaveLength(0)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "working tree changed after run",
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("resumes an already-complete run without invoking its finder", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const initial = review(fixture)
      expect(yield* initial.effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      renameSync(
        join(fixture.content, "prompts"),
        join(fixture.content, "prompts-unavailable"),
      )
      writeFileSync(
        join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-edit\n",
      )
      const completedResume = resume(fixture, runId)
      expect(yield* completedResume.effect).toBe(0)
      expect(completedResume.scripted.configs).toHaveLength(0)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        `resuming run ${runId}`,
      )
      expect(yield* fs.exists(join(fixture.runsRoot, runId, "report.md"))).toBe(
        true,
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("help is not a failed review: plain help exits 0, bad usage exits 1", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      const scripted = successfulScripted()
      const layer = Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
        scriptedLayer(scripted),
      )
      const helpExit = yield* runGauntlet([]).pipe(
          Effect.provideService(InvocationDirectory, fixture.repo),
          Effect.provideService(ContentDirectory, fixture.content),
          Effect.provide(layer),
        )
      expect(helpExit).toBe(0)
      const badExit = yield* runGauntlet(["not-a-subcommand"]).pipe(
        Effect.provideService(InvocationDirectory, fixture.repo),
        Effect.provideService(ContentDirectory, fixture.content),
        Effect.provide(layer),
      )
      expect(badExit).toBe(1)
      expect((yield* TestConsole.errorLines).join("\n")).not.toContain(
        "could not review",
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("exits 1 with no run directory when the tree has nothing to review", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      writeFileSync(join(fixture.repo, "alpha.txt"), "first line\n")
      commitAll(fixture.repo, "initial")

      const exitCode = yield* review(fixture).effect
      expect(exitCode).toBe(1)
      expect(yield* TestConsole.logLines).toEqual([])
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "could not review — working tree has no uncommitted changes",
      )

      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("exits 1 outside a git repository", () =>
    Effect.gen(function* () {
      const fixture = makeFixture()
      const plain = join(fixture.home, "plain")
      mkdirSync(plain)
      const outside = { ...fixture, repo: plain }

      const exitCode = yield* review(outside).effect
      expect(exitCode).toBe(1)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "could not review — not inside a git repository",
      )
    }).pipe(Effect.provide(NodeServices.layer)))
})
