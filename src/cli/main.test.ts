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
  type GitHubIssueComment,
  type PullRequestView,
} from "../github/github.ts"
import {
  LinearError,
  Linear,
  unusedLinearLayer,
  type LinearBranchIssue,
  type LinearCommentSnapshot,
  type LinearIssueSnapshot,
} from "../linear/linear.ts"
import { formatCommentOmission } from "../specification/comment-budget.ts"
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
import { chompLine, runGit } from "../target/git.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { REVIEW_WORKSPACE_ROOT } from "../workspace/review-workspace.ts"
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
    "repo={{REPO_ROOT}}\nfiles={{CHANGED_FILES}}\n{{DIFF_SECTION}}\n",
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

const makePrReviewFixture = Effect.gen(function* () {
  const fixture = yield* makeFixture
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.writeFileString(path.join(fixture.repo, "alpha.txt"), "first line\n")
  yield* commitAll(fixture.repo, "base")
  const baseCommit = chompLine(yield* runGit(fixture.repo, ["rev-parse", "HEAD"]))
  yield* fs.writeFileString(
    path.join(fixture.repo, "alpha.txt"),
    "first line\nneedle-added-line\n",
  )
  yield* commitAll(fixture.repo, "head")
  const headCommit = chompLine(yield* runGit(fixture.repo, ["rev-parse", "HEAD"]))
  return { baseCommit, fixture, headCommit }
})

const prView = (
  number: number,
  headRefOid: string,
  baseRefOid: string,
): PullRequestView => ({
  number,
  headRefOid,
  baseRefOid,
  baseRefName: "main",
  url: `https://github.com/example/repo/pull/${String(number)}`,
})

const issueUrl = (number: number) =>
  `https://github.com/example/repo/issues/${String(number)}`

const githubComment = (
  association: string,
  createdAt: string,
  body: string,
  number = 74,
): GitHubIssueComment => ({
  url: `${issueUrl(number)}#issuecomment-${createdAt}`,
  body,
  createdAt,
  authorAssociation: association,
})

const closingIssue = (
  number: number,
  title: string,
  body: string,
  comments: ReadonlyArray<GitHubIssueComment> = [],
  parent: GitHubClosingIssue["parent"] = undefined,
): GitHubClosingIssue => ({
  number,
  url: issueUrl(number),
  title,
  body,
  state: "OPEN",
  comments,
  parent,
})

const githubForPr = (
  view: PullRequestView,
  issues: ReadonlyArray<GitHubClosingIssue>,
) =>
  gitHubLayer({
    ...unusedGitHubContract,
    viewPullRequest: () => Effect.succeed(view),
    viewClosingIssues: () => Effect.succeed(issues),
  })

const linearComment = (
  body: string,
  createdAt: string,
  isBot = false,
): LinearCommentSnapshot => ({
  url: `https://linear.app/example/comment/${body.replaceAll(" ", "-")}`,
  body,
  createdAt,
  isBot,
})

const linearIssue = (
  identifier: string,
  title: string,
  body: string,
  state: string,
  comments: ReadonlyArray<LinearCommentSnapshot> = [],
): LinearIssueSnapshot => ({
  id: `id-${identifier}`,
  identifier,
  url: `https://linear.app/example/issue/${identifier}`,
  title,
  body,
  state,
  comments,
})

const linearBranchIssue = (): LinearBranchIssue => ({
  ...linearIssue(
    "ENG-75",
    "Linear source",
    "LINEAR-SLICE-BODY",
    "In Progress",
    [
      linearComment("newer human", "2026-01-03T00:00:00Z"),
      linearComment("linkback bot", "2026-01-02T00:00:00Z", true),
    ],
  ),
  parent: linearIssue(
    "ENG-70",
    "Review specification",
    "LINEAR-PARENT-BODY",
    "Todo",
    [linearComment("older human", "2026-01-01T00:00:00Z")],
  ),
  siblings: [
    linearIssue("ENG-76", "Conformance", "NOT-FETCHED", "Done"),
    linearIssue("ENG-74", "GitHub source", "NOT-FETCHED", "Canceled"),
  ],
})

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
      expect(plan.target.untrackedFiles).toHaveLength(1)
      expect(plan.target.untrackedFiles[0]?.path).toBe("untracked.txt")
      expect(plan.target.untrackedFiles[0]?.digest).toMatch(/^[a-f0-9]{64}$/)
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
      expect(dossier.bugClaims).toHaveLength(1)
      expect(dossier.bugClaims[0]?.candidate._tag).toBe("BugClaim")
      expect(dossier.bugClaims[0]?.candidate.id).toBe("fixture-review/1")
      expect(dossier.bugClaims[0]?.verdict).toEqual({
        _tag: "Confirmed",
        reviewPriority: "P2",
        evidence: "empty input reaches the added line and throws",
      })
      expect(dossier.testSuggestions).toEqual([
        {
          tests: ["the alpha input suite"],
          reason: "it exercises empty inputs against the added line",
          bugClaimIds: ["fixture-review/1"],
        },
      ])
      expect(dossier.observations).toHaveLength(1)
      expect(dossier.observations[0]?.candidate._tag).toBe("Observation")
      expect(dossier.observations[0]?.candidate.id).toBe("fixture-review/2")
      expect(dossier.observations[0]?.judgment).toMatchObject({
        _tag: "Kept",
        reviewPriority: "P2",
        goodFind: true,
        cleanlyExplained: true,
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

      // The diff is stored exactly once, in the plan (ADR 0006). Untracked
      // file bytes are not persisted anywhere in the run directory.
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
      ])

      const dossier = yield* fs.readFileString(path.join(runDir, "dossier.json")).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
      )
      expect(dossier.testSuggestions).toEqual([
        {
          tests: ["the alpha input suite"],
          reason: "it exercises empty inputs against the added line",
          bugClaimIds: ["fixture-review/1"],
        },
      ])
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

  it.effect("loads the full shipped and project-local catalog and freezes seats", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const projectLenses = path.join(fixture.repo, ".gauntlet", "lenses")
      yield* fs.makeDirectory(projectLenses, { recursive: true })
      yield* fs.writeFileString(
        path.join(projectLenses, "fixture-local.md"),
        "---\nfinder-class: interpretive\n---\nfixture local tail\n",
      )
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: FIXTURE_SEAT,
        "interpretive-finders": "fixture/local-model:medium",
      })

      // One standard + one interpretive seat keeps each model group size-1,
      // so the cache settle never fires and this stays free of TestClock.
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
      const seatByLens = new Map(
        plan.lenses.map((lens) => [lens.name, lens.seat]),
      )
      expect(seatByLens.get("fixture-review")).toBe(FIXTURE_SEAT)
      expect(seatByLens.get("fixture-local")).toBe("fixture/local-model:medium")

      expect(
        yield* fs.exists(
          path.join(fixture.runsRoot, runId, "finder-stage.json"),
        ),
      ).toBe(true)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "gauntlet: 0 BugClaims → Verification · 0 Observations → Judgment",
      )
      expect(stderr).toContain("gauntlet: skipping Pool (0 BugClaims)")
      expect(stderr).toContain("gauntlet: skipping Verification (0 BugClaims)")
      expect(stderr).toContain("gauntlet: skipping Judgment (0 Observations)")
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

  it.effect("freezes seats from a positional recipe for every stage and both finder classes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-interpretive.md"),
        "---\nfinder-class: interpretive\n---\nfixture interpretive tail\n",
      )
      // fixture-recipe stays the configured default; naming fixture-full
      // positionally must win (selection precedence, ADR 0005).
      yield* writeRecipe(fixture, "fixture-full", {
        default: "fixture/default-model:low",
        finders: "fixture/finder-model:low",
        "interpretive-finders": "fixture/interpretive-model:high",
        pool: "fixture/pool-model:low",
        verification: "fixture/verify-model:low",
        judgment: "fixture/judge-model:low",
      })
      const run = runCommand(
        fixture,
        ["review", "fixture-full", "--lenses", "fixture-review,fixture-interpretive"],
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
      expect(seatByLens.get("fixture-interpretive")).toBe(
        "fixture/interpretive-model:high",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps spec-conformance out of implicit Lens selection until Default Lenses owns membership", () =>
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
        ["review"],
        makeScripted({
          sessions: [successfulSession({ findings: [] })],
        }),
      )

      expect(yield* run.effect).toBe(0)
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(plan.lenses.map(({ name }) => name)).toEqual(["fixture-review"])
      expect(run.scripted.configs).toHaveLength(1)
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
      expect(dossier.bugClaims[0]?.candidate.summary).toBe(
        "the added line breaks empty inputs",
      )
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "reusing completed Finder stage",
      )
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "gauntlet: finder fixture-review done — 4 candidates · 0s · $0.05",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("starts a new review under the frozen recipe when resume finds a changed target", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      yield* writeRecipe(fixture, "fixture-alt", { default: FIXTURE_SEAT })
      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        ["review", "fixture-alt", "--lenses", "fixture-review"],
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

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-edit\n",
      )

      // The destination guard fires before the fallback pays anything: a
      // working-tree run has no PR destination, changed target or not.
      const refused = runCommand(
        fixture,
        ["review", "--resume", runId, "--destination", "pr"],
        makeScripted({ sessions: [] }),
      )
      expect(yield* refused.effect).toBe(1)
      expect(refused.scripted.configs).toHaveLength(0)

      const driftedResume = resume(fixture, runId, successfulScripted())
      expect(yield* driftedResume.effect).toBe(0)
      expect(driftedResume.scripted.configs).toHaveLength(3)
      const runIds = yield* fs.readDirectory(fixture.runsRoot)
      expect(runIds).toHaveLength(2)
      expect(runIds).toContain(runId)

      // The replacement review keeps the abandoned plan's recipe rather than
      // silently reverting to the configured default.
      const replacementId = runIds.find((id) => id !== runId) ?? ""
      const planText = yield* fs.readFileString(
        path.join(fixture.runsRoot, replacementId, "plan.json"),
      )
      const plan = yield* Schema.decodeEffect(
        Schema.fromJsonString(ReviewPlan),
      )(planText)
      expect(plan.recipeName).toBe("fixture-alt")
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "resume unavailable, running a new review",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("starts a new review when only untracked file contents changed", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "stray.txt"),
        "original-untracked\n",
      )
      const stageCommitted = yield* Deferred.make<string>()
      const first = runCommand(
        fixture,
        ["review", "--lenses", "fixture-review"],
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

      yield* fs.writeFileString(
        path.join(fixture.repo, "stray.txt"),
        "edited-untracked\n",
      )

      const driftedResume = resume(fixture, runId, successfulScripted())
      expect(yield* driftedResume.effect).toBe(0)
      expect(driftedResume.scripted.configs).toHaveLength(3)
      const runIds = yield* fs.readDirectory(fixture.runsRoot)
      expect(runIds).toHaveLength(2)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "resume unavailable, running a new review",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("freezes a caller addendum and shows it to interpretive finders, verification, and judgment — never standard finders or pool", () =>
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

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(plan.specification).toEqual({
        documents: [
          {
            role: "caller-addendum",
            provenance: addendumPath,
            text: `${needle}\n`,
          },
        ],
        comments: [],
      })
      const classByLens = new Map(
        plan.lenses.map((lens) => [lens.name, lens.finderClass]),
      )
      expect(classByLens.get("fixture-review")).toBeUndefined()
      expect(classByLens.get("fixture-interpretive")).toBe("interpretive")

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
        ["review", "--lenses", "fixture-review", "--spec", path.join(fixture.home, "missing.md")],
        makeScripted({ sessions: [] }),
      )
      expect(yield* missing.effect).toBe(1)
      expect(missing.scripted.configs).toHaveLength(0)

      const emptyPath = path.join(fixture.home, "empty.md")
      yield* fs.writeFileString(emptyPath, "  \n\n")
      const empty = runCommand(
        fixture,
        ["review", "--lenses", "fixture-review", "--spec", emptyPath],
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
        ["review", "--lenses", "fixture-review", "--spec", addendumPath],
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

  it.effect("freezes GitHub closing issues beside a Caller Addendum on a PR review", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-interpretive.md"),
        "---\nfinder-class: interpretive\n---\nfixture interpretive tail\n",
      )
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: FIXTURE_SEAT,
        "interpretive-finders": "fixture/interpretive-model:high",
      })
      const addendumPath = path.join(fixture.home, "addendum.md")
      const addendumNeedle = "ADDENDUM-REQUIREMENT: keep the caller note"
      yield* fs.writeFileString(addendumPath, `${addendumNeedle}\n`)
      const parent = closingIssue(70, "parent spec", "PARENT-BODY")
      const issues = [
        closingIssue(74, "github source", "SLICE-BODY", [
          githubComment("OWNER", "2026-01-01T00:00:00Z", "OWNER-COMMENT"),
          githubComment("CONTRIBUTOR", "2026-01-02T00:00:00Z", "CONTRIBUTOR-COMMENT"),
          githubComment("MEMBER", "2026-01-03T00:00:00Z", "MEMBER-COMMENT"),
        ], parent),
      ]
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
      const run = runCommand(
        fixture,
        [
          "review",
          "--pr",
          "7",
          "--lenses",
          "fixture-review,fixture-interpretive",
          "--spec",
          addendumPath,
        ],
        makeScripted({
          sessions: [
            successfulSession(threeBugClaims, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-2"),
            emittingSession(
              { clusters: [{ indexes: [1, 2, 3], summary: "one shared defect" }] },
              "-pool",
            ),
            successfulVerifierSession(),
            successfulJudgmentSession(),
          ],
        }),
        Effect.void,
        githubForPr(prView(7, headCommit, baseCommit), issues),
      )
      expect(yield* run.effect).toBe(0)

      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(plan.specification?.documents.map((document) => document.role)).toEqual([
        "parent",
        "slice",
        "caller-addendum",
      ])
      expect(plan.specification?.comments.map((entry) => entry.text)).toEqual([
        "OWNER-COMMENT",
        "MEMBER-COMMENT",
      ])

      const [standardPrompt = ""] = promptTextsFor(run.scripted, "-finders-1")
      const [poolPrompt = ""] = promptTextsFor(run.scripted, "-pool")
      const [interpretivePrompt = ""] = promptTextsFor(run.scripted, "-finders-2")
      for (const prompt of [standardPrompt, poolPrompt]) {
        expect(prompt).not.toContain("SLICE-BODY")
        expect(prompt).not.toContain(addendumNeedle)
        expect(prompt).not.toContain("Review Specification")
      }
      expect(interpretivePrompt).toContain("PARENT-BODY")
      expect(interpretivePrompt).toContain("SLICE-BODY")
      expect(interpretivePrompt).toContain("OWNER-COMMENT")
      expect(interpretivePrompt).toContain("MEMBER-COMMENT")
      expect(interpretivePrompt).not.toContain("CONTRIBUTOR-COMMENT")
      expect(interpretivePrompt.indexOf("SLICE-BODY")).toBeLessThan(
        interpretivePrompt.indexOf(addendumNeedle),
      )
      expect(interpretivePrompt).toContain(
        "### Caller Addendum (caller-provided:",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("GitHub specification unavailability leaves the ordinary review specification-less", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      const run = runCommand(
        fixture,
        ["review", "--pr", "7", "--lenses", "fixture-review"],
        successfulScripted(),
        Effect.void,
        gitHubLayer({
          ...unusedGitHubContract,
          viewPullRequest: () =>
            Effect.succeed(prView(7, headCommit, baseCommit)),
          viewClosingIssues: () =>
            Effect.fail(
              new GitHubError({
                operation: "specification",
                reason: "GitHub unavailable",
              }),
            ),
        }),
      )
      expect(yield* run.effect).toBe(0)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(plan.specification).toBeUndefined()
      const prompts = run.scripted.prompts.map(({ text }) => text).join("\n")
      expect(prompts).not.toContain("Review Specification")
      expect(prompts).not.toContain("GitHub unavailable")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("comment-budget omission reaches the frozen spec, prompts, and report", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-interpretive.md"),
        "---\nfinder-class: interpretive\n---\nfixture interpretive tail\n",
      )
      yield* writeRecipe(fixture, "fixture-recipe", {
        default: FIXTURE_SEAT,
        "interpretive-finders": "fixture/interpretive-model:high",
      })
      const issues = [
        closingIssue(74, "github source", "SLICE-BODY-INTACT", [
          githubComment("OWNER", "2026-01-01T00:00:00Z", "o".repeat(8_000)),
          githubComment("OWNER", "2026-01-02T00:00:00Z", "m".repeat(8_000)),
          githubComment("OWNER", "2026-01-03T00:00:00Z", "n".repeat(8_000)),
        ]),
      ]
      const run = runCommand(
        fixture,
        ["review", "--pr", "7", "--lenses", "fixture-review,fixture-interpretive"],
        makeScripted({
          sessions: [
            successfulSession(FINDER_OUTPUT, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-2"),
            successfulVerifierSession(),
            successfulJudgmentSession(),
          ],
        }),
        Effect.void,
        githubForPr(prView(7, headCommit, baseCommit), issues),
      )
      expect(yield* run.effect).toBe(0)
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      const omission = formatCommentOmission({
        droppedCount: 1,
        droppedCharacters: 8_000,
        cutoff: "2026-01-02T00:00:00Z",
      })
      expect(plan.specification?.commentOmission).toEqual({
        droppedCount: 1,
        droppedCharacters: 8_000,
        cutoff: "2026-01-02T00:00:00Z",
      })
      expect(plan.specification?.documents[0]?.text).toBe("SLICE-BODY-INTACT")
      const [interpretivePrompt = ""] = promptTextsFor(run.scripted, "-finders-2")
      expect(interpretivePrompt).toContain(omission)
      expect(interpretivePrompt).toContain("SLICE-BODY-INTACT")
      const markdown = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "dossier.md"),
      )
      expect(markdown).toContain(`- Comment budget: ${omission}`)
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

  it.effect("changed-target PR resume reuses the frozen specification without re-fetching", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      let currentView = prView(7, headCommit, baseCommit)
      let currentIssues: ReadonlyArray<GitHubClosingIssue> = [
        closingIssue(74, "github source", "FROZEN-SLICE"),
      ]
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () => Effect.succeed(currentView),
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

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-line\n",
      )
      yield* commitAll(fixture.repo, "later")
      const laterCommit = chompLine(
        yield* runGit(fixture.repo, ["rev-parse", "HEAD"]),
      )
      currentView = prView(7, laterCommit, baseCommit)
      currentIssues = [closingIssue(74, "github source", "MUTATED-SLICE")]

      const resumed = runCommand(
        fixture,
        ["review", "--resume"],
        successfulScripted(),
        Effect.void,
        github,
      )
      expect(yield* resumed.effect).toBe(0)
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "resume unavailable, running a new review",
      )
      const [verifierPrompt = ""] = promptTextsFor(
        resumed.scripted,
        "-verification",
      )
      expect(verifierPrompt).toContain("FROZEN-SLICE")
      expect(verifierPrompt).not.toContain("MUTATED-SLICE")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("changed-target PR resume also freezes quiet specification absence", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      let currentView = prView(7, headCommit, baseCommit)
      let currentIssues: ReadonlyArray<GitHubClosingIssue> = []
      let specificationCalls = 0
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () => Effect.succeed(currentView),
        viewClosingIssues: () => {
          specificationCalls += 1
          return Effect.succeed(currentIssues)
        },
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

      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nlater-line\n",
      )
      yield* commitAll(fixture.repo, "later")
      currentView = prView(
        7,
        chompLine(yield* runGit(fixture.repo, ["rev-parse", "HEAD"])),
        baseCommit,
      )
      currentIssues = [
        closingIssue(74, "github source", "LATE-SLICE"),
      ]

      const resumed = runCommand(
        fixture,
        ["review", "--resume"],
        successfulScripted(),
        Effect.void,
        github,
      )
      expect(yield* resumed.effect).toBe(0)
      expect(specificationCalls).toBe(1)
      expect(
        resumed.scripted.prompts.map(({ text }) => text).join("\n"),
      ).not.toContain("LATE-SLICE")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("freezes a branch-bound Linear specification for a WorkingTree review", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* runGit(fixture.repo, [
        "switch",
        "-c",
        "john/eng-75-linear-source",
      ])
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-interpretive.md"),
        "---\nfinder-class: interpretive\n---\nfixture interpretive tail\n",
      )
      const requested: Array<string> = []
      const run = runCommand(
        fixture,
        [
          "review",
          "--lenses",
          "fixture-review,fixture-interpretive",
        ],
        makeScripted({
          sessions: [
            successfulSession(FINDER_OUTPUT, "-finders-1"),
            successfulSession({ findings: [] }, "-finders-2"),
            successfulVerifierSession(),
            successfulJudgmentSession(),
          ],
        }),
        Effect.void,
        unusedGitHubLayer,
        Linear.Fake({
          viewIssue: (identifier) => {
            requested.push(identifier)
            return Effect.succeed(linearBranchIssue())
          },
        }),
      )

      expect(yield* run.effect).toBe(0)
      expect(requested).toEqual(["ENG-75"])
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(
        plan.specification?.documents.map(({ role, state, text }) => ({
          role,
          state,
          text,
        })),
      ).toEqual([
        { role: "parent", state: "Todo", text: "LINEAR-PARENT-BODY" },
        {
          role: "slice",
          state: "In Progress",
          text: "LINEAR-SLICE-BODY",
        },
        { role: "sibling", state: "Canceled", text: "" },
        { role: "sibling", state: "Done", text: "" },
      ])
      expect(plan.specification?.comments.map(({ text }) => text)).toEqual([
        "older human",
        "newer human",
      ])
      expect(plan.specificationSourceDiagnostic).toBeUndefined()

      const [standardPrompt = ""] = promptTextsFor(run.scripted, "-finders-1")
      const [interpretivePrompt = ""] = promptTextsFor(
        run.scripted,
        "-finders-2",
      )
      const [verifierPrompt = ""] = promptTextsFor(
        run.scripted,
        "-verification",
      )
      const [judgmentPrompt = ""] = promptTextsFor(run.scripted, "-judgment")
      expect(standardPrompt).not.toContain("LINEAR-SLICE-BODY")
      for (const prompt of [interpretivePrompt, verifierPrompt, judgmentPrompt]) {
        expect(prompt).toContain("LINEAR-PARENT-BODY")
        expect(prompt).toContain("LINEAR-SLICE-BODY")
        expect(prompt).toContain("Sibling: GitHub source")
        expect(prompt).toContain("older human")
        expect(prompt).toContain("newer human")
        expect(prompt).not.toContain("linkback bot")
        expect(prompt).not.toContain("NOT-FETCHED")
      }
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("starts a fresh review when the branch-bound Linear issue changes", () =>
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
        ["review", "--lenses", "fixture-review"],
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
        successfulScripted(),
        Effect.void,
        unusedGitHubLayer,
        linear,
      )
      expect(yield* resumed.effect).toBe(0)
      expect(requested).toEqual(["ENG-75", "ENG-76"])
      expect((yield* TestConsole.errorLines).join("\n")).toContain(
        "resume unavailable, running a new review",
      )
      const resumedPrompts = resumed.scripted.prompts
        .map(({ text }) => text)
        .join("\n")
      expect(resumedPrompts).toContain("LINEAR-SLICE-ENG-76")
      expect(resumedPrompts).not.toContain("LINEAR-SLICE-ENG-75")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("prefers the branch-bound Linear source when a PR also has GitHub closing issues", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      yield* runGit(fixture.repo, [
        "switch",
        "-c",
        "john/eng-75-linear-source",
      ])
      let githubSpecificationCalls = 0
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () =>
          Effect.succeed(prView(7, headCommit, baseCommit)),
        viewClosingIssues: () => {
          githubSpecificationCalls += 1
          return Effect.succeed([
            closingIssue(74, "GitHub source", "GITHUB-SLICE-BODY"),
          ])
        },
      })
      const run = runCommand(
        fixture,
        ["review", "--pr", "7", "--lenses", "fixture-review"],
        successfulScripted(),
        Effect.void,
        github,
        Linear.Fake({
          viewIssue: () => Effect.succeed(linearBranchIssue()),
        }),
      )

      expect(yield* run.effect).toBe(0)
      expect(githubSpecificationCalls).toBe(0)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      const specification = plan.specification?.documents
        .map(({ text }) => text)
        .join("\n") ?? ""
      expect(specification).toContain("LINEAR-SLICE-BODY")
      expect(specification).not.toContain("GITHUB-SLICE-BODY")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("reports a matching branch whose Linear API key is missing without blocking review", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      yield* runGit(fixture.repo, [
        "switch",
        "-c",
        "john/eng-75-linear-source",
      ])
      const run = runCommand(
        fixture,
        ["review", "--lenses", "fixture-review"],
        successfulScripted(),
        Effect.void,
        unusedGitHubLayer,
        Linear.Fake({
          viewIssue: () =>
            Effect.fail(
              new LinearError({
                reason: "missing-api-key",
                detail: "LINEAR_API_KEY is not set",
              }),
            ),
        }),
      )

      expect(yield* run.effect).toBe(0)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
      const plan = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "plan.json"),
      ).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
      )
      expect(plan.specification).toBeUndefined()
      expect(plan.specificationSourceDiagnostic?.reason).toBe("missing-api-key")
      const diagnostic = plan.specificationSourceDiagnostic?.message ?? ""
      expect(diagnostic).toContain("LINEAR_API_KEY is not set")
      expect((yield* TestConsole.errorLines).join("\n")).toContain(diagnostic)
      const markdown = yield* fs.readFileString(
        path.join(fixture.runsRoot, runId, "dossier.md"),
      )
      expect(markdown).toContain(`- Specification source: ${diagnostic}`)
      expect(run.scripted.prompts.map(({ text }) => text).join("\n")).not.toContain(
        "Review Specification",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
