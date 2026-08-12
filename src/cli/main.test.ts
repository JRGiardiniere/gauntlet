import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Deferred from "effect/Deferred"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Queue from "effect/Queue"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import * as TestClock from "effect/testing/TestClock"
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
  type ScriptedSession,
  usageRow,
} from "../harness/scripted.ts"
import { FindingsOutput } from "../harness/output-contract.ts"
import {
  InvocationArtifact,
  InvocationJournalCheckpoint,
} from "../run/invocation-journal.ts"
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
{{DIFF_SECTION}}
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
  writeFileSync(
    join(content, "prompts", "pool.md"),
    "pool candidates\n{{CANDIDATES}}\n",
  )
  writeFileSync(
    join(content, "prompts", "verifier.md"),
    "verify claims\n{{SCOPE_BLOCK}}\n{{CLAIMS}}\n",
  )
  writeFileSync(
    join(content, "prompts", "judge.md"),
    "judge observations\n{{SCOPE_BLOCK}}\n{{CANDIDATES}}\n",
  )
  writeFileSync(
    join(content, "prompts", "stage-scope-block.md"),
    "repo={{REPO_ROOT}}\nfiles={{CHANGED_FILES}}\n{{DIFF_SECTION}}\nintent={{INTENT_SECTION}}\n",
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
): ScriptedSession => emittingSession(output)

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

const droppingJudgmentSession = (count: number): ScriptedSession =>
  emittingSession({
    decisions: globalThis.Array.from({ length: count }, (_, index) => ({
      index: index + 1,
      decision: "drop",
      reason: "fixture decision: no nameable payer",
    })),
  }, "-judgment")

const rejectedJudgmentSession = (): ScriptedSession => {
  const prompt = {
    events: [
      { afterMillis: 0, kind: "message_start" as const },
      {
        afterMillis: 0,
        kind: "emit" as const,
        args: {
          decisions: [{
            index: 1,
            decision: "keep",
            reason: "missing the required keep fields",
          }],
        },
        valid: false,
      },
      {
        afterMillis: 0,
        kind: "message_end" as const,
        stopReason: "toolUse" as const,
        usage: usageRow(),
      },
    ],
    settles: "after-events" as const,
  }
  return { forSession: "-judgment", prompts: [prompt, prompt, prompt] }
}

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
      expect(plan.seats.pool).toBe("openai-codex/gpt-5.6-luna:low")
      expect(plan.seats.verification).toBe("openai-codex/gpt-5.6-luna:low")
      expect(plan.seats.judgment).toBe("openai-codex/gpt-5.6-luna:low")
      expect(plan.target._tag).toBe("WorkingTree")
      expect(plan.target.changedFiles).toEqual(["alpha.txt"])
      expect(plan.target.diff).toContain("+needle-added-line")

      const journalEntries = yield* fs.readDirectory(join(runDir, "journal"))
      expect(journalEntries.sort()).toEqual([
        "finder-fixture-review.json",
        "judgment.json",
        "verification-bundle-1.json",
      ])
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

      const report = yield* fs.readFileString(join(runDir, "report.md"))
      expect(report).toContain(`# Gauntlet review ${plan.runId}`)
      expect(report).toContain("the added line breaks empty inputs")
      expect(report).toContain("the name hides the value's role")
      expect(report).toContain("3 invocations")
      expect(report).toContain(
        "Recipe: none (finders: openai-codex/gpt-5.6-luna:low, pool: openai-codex/gpt-5.6-luna:low, verification: openai-codex/gpt-5.6-luna:low, judgment: openai-codex/gpt-5.6-luna:low)",
      )

      // The diff is stored exactly once, in the plan (ADR 0006).
      const runRecordText = planText + journalText + dossierText + report
      expect(runRecordText.split("needle-added-line").length - 1).toBe(1)

      expect(run.scripted.configs).toHaveLength(3)
      expect(run.scripted.configs[0]?.seat).toBe(
        "openai-codex/gpt-5.6-luna:low",
      )
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
      const [judgmentPrompt] = promptTextsFor(run.scripted, "-judgment")
      expect(judgmentPrompt).toContain("judge observations")
      expect(judgmentPrompt).toContain(
        "[1] (fixture-review) alpha.txt — the name hides the value's role",
      )

      const runLog = yield* fs.readFileString(join(runDir, "run.log"))
      expect(runLog.length).toBeGreaterThan(0)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("runs emit-only Pool and one verifier per four-cluster bundle", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const findings = globalThis.Array.from({ length: 5 }, (_, index) => ({
        file: "alpha.txt",
        line: 2,
        summary: `claim ${String(index + 1)}`,
        failure_scenario: `input ${String(index + 1)} fails`,
      }))
      const scripted = makeScripted({
        sessions: [
          successfulSession({ findings }),
          emittingSession({
            clusters: findings.map((finding, index) => ({
              indexes: [index + 1],
              summary: finding.summary,
            })),
          }),
          // The bundles run concurrently, so each verdict script is keyed to
          // its bundle's session id instead of relying on open order.
          emittingSession({
            verdicts: [
              {
                cluster: 1,
                verdict: "CONFIRMED",
                severity: "P2",
                evidence: "claim one reproduced",
              },
              {
                cluster: 2,
                verdict: "UNVERIFIED",
                severity: "P2",
                evidence: "trigger depends on runtime state",
              },
              {
                cluster: 3,
                verdict: "REFUTED",
                evidence: "the guard rejects input three",
              },
              {
                cluster: 4,
                verdict: "CONFIRMED",
                severity: "P1",
                evidence: "claim four reproduced",
              },
            ],
          }, "-verification-1"),
          emittingSession({
            verdicts: [
              {
                cluster: 5,
                verdict: "CONFIRMED",
                severity: "P3",
                evidence: "claim five reproduced",
              },
            ],
          }, "-verification-2"),
        ],
      })

      expect(yield* review(fixture, scripted).effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const runDir = join(fixture.runsRoot, runId)
      expect((yield* fs.readDirectory(join(runDir, "journal"))).sort()).toEqual([
        "finder-fixture-review.json",
        "pool.json",
        "verification-bundle-1.json",
        "verification-bundle-2.json",
      ])

      const dossier = yield* fs.readFileString(join(runDir, "dossier.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
      )
      expect(dossier.bugClaims.map(({ verdict }) => verdict._tag)).toEqual([
        "Confirmed",
        "Unverified",
        "Refuted",
        "Confirmed",
        "Confirmed",
      ])
      expect(dossier.coverageGaps).toEqual([])

      const report = yield* fs.readFileString(join(runDir, "report.md"))
      const findingsSection = report.split("## Appendix: refuted claims")[0] ?? ""
      expect(findingsSection.indexOf("claim 4")).toBeLessThan(
        findingsSection.indexOf("claim 1"),
      )
      expect(findingsSection.indexOf("claim 1")).toBeLessThan(
        findingsSection.indexOf("claim 2"),
      )
      expect(findingsSection).toContain("`[unverified]`")
      expect(findingsSection).not.toContain("claim 3")
      expect(report).toContain("`[refuted]` alpha.txt:2 — claim 3")
      expect(report).toContain("$0.20 · 4 invocations")

      expect(scripted.configs).toHaveLength(4)
      expect(scripted.configs[1]?.tools).toEqual([])
      const verifierPrompts = scripted.prompts
        .map(({ text }) => text)
        .filter((prompt) => prompt.startsWith("verify claims"))
      expect(verifierPrompts).toHaveLength(2)
      expect(verifierPrompts.some((prompt) => prompt.includes("[c4]"))).toBe(true)
      expect(verifierPrompts.some((prompt) => prompt.includes("[c5]"))).toBe(true)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("fails a whole verifier bundle closed when its verdict set is incomplete", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const scripted = makeScripted({
        sessions: [
          successfulSession({
            findings: [
              {
                file: "alpha.txt",
                line: 2,
                summary: "first claim",
                failure_scenario: "first input fails",
              },
              {
                file: "alpha.txt",
                line: 2,
                summary: "second claim",
                failure_scenario: "second input fails",
              },
            ],
          }),
          emittingSession({
            verdicts: [
              {
                cluster: 1,
                verdict: "CONFIRMED",
                severity: "P1",
                evidence: "only one cluster was returned",
              },
            ],
          }),
        ],
      })

      expect(yield* review(fixture, scripted).effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const dossier = yield* fs.readFileString(
        join(fixture.runsRoot, runId, "dossier.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
      )
      expect(dossier.bugClaims.map(({ verdict }) => verdict._tag)).toEqual([
        "Unverified",
        "Unverified",
      ])
      expect(dossier.coverageGaps).toEqual([
        {
          stage: "verification",
          reason:
            "verification bundle 1 did not report every cluster exactly once",
        },
      ])
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("keeps an off-spec Judgment visible as undecided at the CLI seam", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const scripted = makeScripted({
        sessions: [
          successfulSession(),
          successfulVerifierSession(),
          rejectedJudgmentSession(),
        ],
      })

      expect(yield* review(fixture, scripted).effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const runDir = join(fixture.runsRoot, runId)
      const dossier = yield* fs.readFileString(join(runDir, "dossier.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
      )
      expect(dossier.observations[0]?.judgment._tag).toBe("Undecided")
      expect(dossier.coverageGaps).toContainEqual({
        stage: "judgment",
        reason: "judgment emitted nothing after 2 corrective turns",
      })

      const report = yield* fs.readFileString(join(runDir, "report.md"))
      expect(report).toContain("`[undecided]` alpha.txt")
      expect(report).toContain("3 invocations")
      expect((yield* fs.readDirectory(join(runDir, "journal"))).sort())
        .toContain("judgment.json")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("loads the full shipped and project-local catalog, skips needs-spec lenses, and groups mixed seats", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      writeFileSync(
        join(fixture.content, "lenses", "fixture-other.md"),
        "fixture other tail\n",
      )
      writeFileSync(
        join(fixture.content, "lenses", "fixture-spec.md"),
        "---\nneeds-spec: true\n---\nfixture spec tail\n",
      )
      const projectLenses = join(fixture.repo, ".gauntlet", "lenses")
      mkdirSync(projectLenses, { recursive: true })
      writeFileSync(
        join(projectLenses, "fixture-local.md"),
        "---\nmodel: fixture/local-model:medium\n---\nfixture local tail\n",
      )

      const scripted = makeScripted({
        sessions: [
          successfulSession({ findings: [] }),
          successfulSession({ findings: [] }),
          successfulSession({ findings: [] }),
        ],
      })
      const run = runCommand(fixture, ["review"], scripted)
      const journaled = yield* Queue.unbounded<string>()
      const fiber = yield* run.effect.pipe(
        Effect.provideService(
          InvocationJournalCheckpoint,
          (_runId, invocationKey) => Queue.offer(journaled, invocationKey),
        ),
        Effect.forkChild,
      )
      yield* Queue.take(journaled)
      yield* Queue.take(journaled)
      yield* TestClock.adjust("1500 millis")
      expect(yield* Fiber.join(fiber)).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(ReviewPlan)),
        ),
      )
      expect(plan.lenses.map((lens) => lens.name)).toEqual([
        "fixture-other",
        "fixture-review",
        "fixture-local",
      ])
      expect(plan.lenses.some((lens) => lens.name === "fixture-spec")).toBe(
        false,
      )
      expect(run.scripted.configs).toHaveLength(3)
      const opened = run.scripted.configs.map((config, index) => ({
        config,
        prompt: run.scripted.prompts
          .find(({ openIndex }) => openIndex === index + 1)?.text ?? "",
      }))
      const local = opened.find((entry) =>
        entry.prompt.includes("fixture local tail")
      )
      const defaults = opened.filter((entry) =>
        !entry.prompt.includes("fixture local tail")
      )
      expect(local?.config.seat).toBe("fixture/local-model:medium")
      expect(defaults.map((entry) => entry.config.seat)).toEqual([
        "openai-codex/gpt-5.6-luna:low",
        "openai-codex/gpt-5.6-luna:low",
      ])
      expect(new Set(defaults.map((entry) => entry.config.sessionId)).size).toBe(
        1,
      )
      expect(local?.config.sessionId).not.toBe(defaults[0]?.config.sessionId)

      const journals = yield* fs.readDirectory(
        join(fixture.runsRoot, runId, "journal"),
      )
      expect(journals.sort()).toEqual([
        "finder-fixture-local.json",
        "finder-fixture-other.json",
        "finder-fixture-review.json",
      ])
      const report = yield* fs.readFileString(
        join(fixture.runsRoot, runId, "report.md"),
      )
      expect(report).toContain("$0.15 · 3 invocations")
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("shares one model cache group across thinking efforts", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      writeFileSync(
        join(fixture.content, "lenses", "fixture-high.md"),
        "---\nmodel: openai-codex/gpt-5.6-luna:high\n---\nfixture high tail\n",
      )
      const run = runCommand(
        fixture,
        ["review", "--lenses", "fixture-review,fixture-high"],
        makeScripted({
          sessions: [
            successfulSession({ findings: [] }),
            successfulSession({ findings: [] }),
          ],
        }),
      )
      const journaled = yield* Queue.unbounded<string>()
      const fiber = yield* run.effect.pipe(
        Effect.provideService(
          InvocationJournalCheckpoint,
          (_runId, invocationKey) => Queue.offer(journaled, invocationKey),
        ),
        Effect.forkChild,
      )
      yield* Queue.take(journaled)
      yield* TestClock.adjust("1500 millis")
      expect(yield* Fiber.join(fiber)).toBe(0)

      expect(run.scripted.configs.map((config) => config.seat).sort()).toEqual([
        "openai-codex/gpt-5.6-luna:high",
        "openai-codex/gpt-5.6-luna:low",
      ])
      expect(
        new Set(run.scripted.configs.map((config) => config.sessionId)).size,
      ).toBe(1)
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("narrows comma-separated lenses and turns a missing emit into a coverage gap without losing its sibling", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      writeFileSync(
        join(fixture.content, "lenses", "fixture-other.md"),
        "fixture other tail\n",
      )
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
      const scripted = makeScripted({
        sessions: [
          {
            prompts: [
              missingEmitPrompt,
              missingEmitPrompt,
              missingEmitPrompt,
            ],
          },
          successfulSession(),
          successfulVerifierSession(),
          successfulJudgmentSession(),
        ],
      })
      const run = runCommand(
        fixture,
        ["review", "--lenses", "fixture-review,fixture-other"],
        scripted,
      )
      const journaled = yield* Queue.unbounded<string>()
      const fiber = yield* run.effect.pipe(
        Effect.provideService(
          InvocationJournalCheckpoint,
          (_runId, invocationKey) => Queue.offer(journaled, invocationKey),
        ),
        Effect.forkChild,
      )
      yield* Queue.take(journaled)
      yield* TestClock.adjust("1500 millis")
      expect(yield* Fiber.join(fiber)).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const dossier = yield* fs.readFileString(
        join(fixture.runsRoot, runId, "dossier.json"),
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
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("truncates over-emitting finder output to the cap frozen in the plan", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      const findings = globalThis.Array.from({ length: 8 }, (_, index) => ({
        file: "alpha.txt",
        line: 2,
        summary: `candidate ${String(index + 1)}`,
      }))
      const run = review(
        fixture,
        makeScripted({
          sessions: [
            successfulSession({ findings }),
            droppingJudgmentSession(6),
          ],
        }),
      )
      expect(yield* run.effect).toBe(0)

      const fs = yield* FileSystem.FileSystem
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(ReviewPlan)),
        ),
      )
      expect(plan.lenses[0]?.candidateCap).toBe(6)
      const journal = yield* fs.readFileString(
        join(
          fixture.runsRoot,
          runId,
          "journal",
          "finder-fixture-review.json",
        ),
      ).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(FinderInvocationArtifact)),
        ),
      )
      expect(journal.outcome.output?.findings).toHaveLength(6)
      expect(journal.outcome.diagnostics).toContain(
        "finder fixture-review emitted 8 candidates; retained the plan cap of 6",
      )
    }).pipe(Effect.provide(NodeServices.layer)))

  it.effect("prints a bounded candidate digest on stdout and narrates on stderr", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()

      const exitCode = yield* review(fixture).effect
      expect(exitCode).toBe(0)

      const stdout = (yield* TestConsole.logLines).join("\n")
      const [tally = ""] = stdout.split("\n")
      expect(tally).toContain("1 confirmed · 1 kept · 0 unverified · 0 undecided")
      expect(tally).toContain("working tree @")
      expect(tally).toContain("recipe: none")
      expect(tally).toMatch(/\$0\.15 · \d+s/)
      expect(stdout).toContain("- [P2] alpha.txt:2")
      expect(stdout).toContain(
        "- [P2] alpha.txt — the name hides the value's role",
      )
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

      writeFileSync(
        join(fixture.content, "lenses", "fixture-review.md"),
        "changed lens content that must not be loaded\n",
      )
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

  it.effect("rechecks the working tree after a warmup before paying its followers", () =>
    Effect.gen(function* () {
      const fixture = makeDirtyRepo()
      writeFileSync(
        join(fixture.content, "lenses", "fixture-other.md"),
        "fixture other tail\n",
      )
      const scripted = makeScripted({
        sessions: [successfulSession(), successfulSession()],
      })
      const run = runCommand(
        fixture,
        ["review", "--lenses", "fixture-review,fixture-other"],
        scripted,
      )
      const journaled = yield* Queue.unbounded<string>()
      const fiber = yield* run.effect.pipe(
        Effect.provideService(
          InvocationJournalCheckpoint,
          (_runId, invocationKey) =>
            Effect.sync(() => {
              writeFileSync(
                join(fixture.repo, "alpha.txt"),
                "first line\nneedle-added-line\nlater-edit\n",
              )
            }).pipe(Effect.andThen(Queue.offer(journaled, invocationKey))),
        ),
        Effect.forkChild,
      )
      yield* Queue.take(journaled)
      yield* TestClock.adjust("1500 millis")

      expect(yield* Fiber.join(fiber)).toBe(1)
      expect(scripted.configs).toHaveLength(1)
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
