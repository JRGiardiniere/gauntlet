import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import * as TestConsole from "effect/testing/TestConsole"
import { SPEC_CONFORMANCE_LENS_NAME } from "../domain/finder-selection.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import {
  GitHubError,
  gitHubLayer,
  unusedGitHubContract,
  unusedGitHubLayer,
} from "../github/github.ts"
import type {
  FindingsOutput,
  PoolOutput,
} from "../harness/output-contract.ts"
import {
  makeScripted,
  type Scripted,
  type ScriptedSession,
  usageRow,
} from "../harness/scripted.ts"
import {
  emittingSession,
  FINDER_OUTPUT,
  FIXTURE_SEAT,
  makeDirtyRepo,
  makePrReviewFixture,
  promptTextsFor,
  provideReviewFixture,
  prView,
  successfulJudgmentSession,
  successfulScripted,
  successfulSession,
  successfulVerifierSession,
  systemPromptsFor,
  writeRecipe,
  writeSettings,
  type Fixture,
} from "../test-support/review.fixture.ts"
import { FinderStageArtifact } from "./finder-execution.ts"
import * as Run from "./run.ts"
import { type RunMilestone, RunMilestones } from "./run-milestones.ts"
import { SubmissionTargetRequest } from "./submission.ts"

// The Run module's interface is the test seam for a Run's lifecycle
// (ADR 0007): each case asks for a review or a delivery and asserts on what
// comes back, and on the run directory where the answer points.

const requestFor = (
  fixture: Fixture,
  fields: Partial<Run.ReviewRequest> = {},
): Run.ReviewRequest => ({
  directory: fixture.repo,
  target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
  recipeName: Option.none(),
  selectedLensNames: ["fixture-review"],
  specPath: undefined,
  relatedFiles: false,
  destination: "local",
  ...fields,
})

const review = (
  fixture: Fixture,
  scripted: Scripted,
  fields: Partial<Run.ReviewRequest> = {},
  github = unusedGitHubLayer,
) =>
  Run.review(requestFor(fixture, fields)).pipe(
    provideReviewFixture(fixture, scripted, github),
  )

const readPlan = (paths: Run.Reviewed["paths"]) =>
  FileSystem.FileSystem.pipe(
    Effect.flatMap((fs) => fs.readFileString(paths.plan)),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
  )

describe("Run.review", () => {
  it.effect("answers a fresh review's run id, Dossier paths and digest, reporting its milestones on the way", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const reported: Array<RunMilestone> = []
      const reviewed = yield* review(fixture, successfulScripted()).pipe(
        Effect.provideService(RunMilestones, (milestone) =>
          Effect.sync(() => {
            reported.push(milestone)
          })),
      )

      const path = yield* Path.Path
      expect(reviewed.paths.root).toBe(path.join(fixture.runsRoot, reviewed.runId))
      expect(reviewed.digest).toContain("1 confirmed · 1 kept · 0 plausible · 0 undecided")
      expect(reviewed.digest).toContain(`dossier.md: ${reviewed.paths.dossierMarkdown}`)
      expect(reviewed.coverageGaps).toEqual([])
      expect(reviewed.delivery).toBeUndefined()
      // The answer is data: a review prints no digest itself.
      expect(yield* TestConsole.logLines).toEqual([])

      expect(reported.map((milestone) => milestone._tag)).toEqual([
        "Started",
        "FindersFinished",
        "Routed",
        "Reviewed",
      ])
      const [started, , routed, done] = reported
      expect(started).toMatchObject({ runId: reviewed.runId, lenses: ["fixture-review"] })
      expect(routed).toMatchObject({ bugClaims: 1, observations: 1 })
      expect(done).toMatchObject({
        entries: [
          { tag: "confirmed", reviewPriority: "P2" },
          { tag: "judgment", reviewPriority: "P2" },
        ],
        dossierMarkdown: reviewed.paths.dossierMarkdown,
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("produces an ordinary zero-result Dossier from empty Default Lenses, freezing related files", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      yield* writeSettings(fixture, {
        "default-recipe": "fixture-recipe",
        "default-lenses": [],
        favorites: [],
      })
      const scripted = makeScripted({ sessions: [] })

      const reviewed = yield* review(fixture, scripted, {
        selectedLensNames: undefined,
        relatedFiles: true,
      })
      expect(scripted.configs).toEqual([])
      const plan = yield* readPlan(reviewed.paths)
      expect(plan.lenses).toEqual([])
      expect(plan.relatedFiles).toBe(true)
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(reviewed.paths.dossierMarkdown)).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("skips explicitly selected spec-conformance without a ReviewSpecification while other Finders run", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", `${SPEC_CONFORMANCE_LENS_NAME}.md`),
        "---\nfinder-class: interpretive\n---\nfixture conformance tail\n",
      )
      const scripted = makeScripted({
        sessions: [successfulSession({ findings: [] })],
      })

      const reviewed = yield* review(fixture, scripted, {
        selectedLensNames: ["fixture-review", SPEC_CONFORMANCE_LENS_NAME],
      })
      const plan = yield* readPlan(reviewed.paths)
      expect(plan.lenses.map(({ name }) => name)).toEqual([
        "fixture-review",
        SPEC_CONFORMANCE_LENS_NAME,
      ])
      const finderStage = yield* fs.readFileString(reviewed.paths.finderStage).pipe(
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(FinderStageArtifact)),
        ),
      )
      expect(finderStage.finders.map(({ invocationKey }) => invocationKey)).toEqual([
        "finder-fixture-review",
      ])
      expect(scripted.configs).toHaveLength(1)
      expect(reviewed.coverageGaps).toEqual([])

      const report = yield* fs.readFileString(reviewed.paths.dossierMarkdown)
      expect(report).toContain(`- Lenses: fixture-review (${FIXTURE_SEAT})`)
      expect(report).not.toContain(`${SPEC_CONFORMANCE_LENS_NAME} (${FIXTURE_SEAT})`)
      expect(
        report.split("\n").filter((line) =>
          line === `- Skipped: ${SPEC_CONFORMANCE_LENS_NAME} — no ReviewSpecification`
        ),
      ).toHaveLength(1)
      expect(report).toContain("1 invocations")

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain("gauntlet: invoking finder fixture-review")
      expect(stderr).not.toContain(`invoking finder ${SPEC_CONFORMANCE_LENS_NAME}`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("answers a Finder's missing emit as a coverage gap without losing its sibling", () =>
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
            prompts: [missingEmitPrompt, missingEmitPrompt, missingEmitPrompt],
          },
          successfulSession(FINDER_OUTPUT, "-finders-2"),
          successfulVerifierSession(),
          successfulJudgmentSession(),
        ],
      })

      const reviewed = yield* review(fixture, scripted, {
        selectedLensNames: ["fixture-review", "fixture-other"],
      })
      expect(reviewed.coverageGaps).toEqual([
        {
          stage: "finders",
          lens: "fixture-review",
          reason: "finder emitted nothing after 2 corrective turns",
        },
      ])
      expect(reviewed.digest).toContain("fixture-review")
      expect(scripted.configs).toHaveLength(4)

      const stderr = (yield* TestConsole.errorLines).join("\n")
      expect(stderr).toContain(
        "gauntlet: finder fixture-review done — 0 candidates · 0s · MissingEmit\n",
      )
      // The cache share is for run.log alone.
      expect(stderr).not.toContain("cache 42%")
      const runLog = yield* fs.readFileString(reviewed.paths.runLog)
      expect(runLog).toContain(
        "finder fixture-review done — 0 candidates · 0s · MissingEmit · cache 42%",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("keeps a failed Judgment's provider diagnostics in run.log, answering the short gap", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
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

      const reviewed = yield* review(
        fixture,
        makeScripted({
          sessions: [successfulSession(), successfulVerifierSession(), failedJudgment],
        }),
      )
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.readFileString(reviewed.paths.runLog)).toContain(
        "529 overloaded: fixture provider body",
      )
      expect(reviewed.coverageGaps.map(({ reason }) => reason)).toEqual([
        "judgment provider failed",
      ])
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
      const scripted = makeScripted({
        sessions: [
          successfulSession(threeBugClaims, "-finders-1"),
          successfulSession({ findings: [] }, "-finders-2"),
          emittingSession(poolOutput, "-pool"),
          successfulVerifierSession(),
          successfulJudgmentSession(),
        ],
      })
      yield* review(fixture, scripted, {
        selectedLensNames: ["fixture-review", "fixture-interpretive"],
        specPath: addendumPath,
      })

      const [standardSystemPrompt = ""] = systemPromptsFor(scripted, "-finders-1")
      expect(standardSystemPrompt).not.toContain(needle)
      expect(standardSystemPrompt).not.toContain("Review Specification")
      const [poolPrompt = ""] = promptTextsFor(scripted, "-pool")
      expect(poolPrompt).not.toContain(needle)
      expect(poolPrompt).not.toContain("Review Specification")

      // Shared context then specification in the system prompt; the
      // assignment alone in the user message.
      const [interpretiveSystemPrompt = ""] = systemPromptsFor(scripted, "-finders-2")
      expect(interpretiveSystemPrompt).toMatch(
        new RegExp(
          `shared end\\n\\n## Review Specification\\n\\n[\\s\\S]*### Caller Addendum \\(caller-provided: [\\s\\S]*${needle}[\\s\\S]*$`,
        ),
      )
      const [interpretivePrompt = ""] = promptTextsFor(scripted, "-finders-2")
      expect(interpretivePrompt).toBe("## Your lens\n\nfixture interpretive tail")
      const [verifierPrompt = ""] = promptTextsFor(scripted, "-verification")
      const [judgmentPrompt = ""] = promptTextsFor(scripted, "-judgment")
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
})

describe("Run delivery", () => {
  it.effect("posts a pull-request review with it, and answers that receipt when delivered again", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      const url = "https://github.com/example/repo/pull/7#issuecomment-1"
      const posts: Array<number> = []
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () => Effect.succeed(prView(7, headCommit, baseCommit)),
        viewClosingIssues: () => Effect.succeed([]),
        postComment: (_cwd, number) =>
          Effect.sync(() => {
            posts.push(number)
            return { url }
          }),
      })

      const reviewed = yield* review(
        fixture,
        successfulScripted(),
        {
          target: SubmissionTargetRequest.PullRequest({ number: 7, githubSpecOnly: false }),
          destination: "pr",
        },
        github,
      )
      expect(reviewed.delivery !== undefined && Result.isSuccess(reviewed.delivery)).toBe(true)
      if (reviewed.delivery === undefined || Result.isFailure(reviewed.delivery)) return
      expect(reviewed.delivery.success.url).toBe(url)

      const again = yield* Run.deliver(reviewed.runId).pipe(
        provideReviewFixture(fixture, makeScripted({ sessions: [] }), github),
      )
      expect(again.url).toBe(url)
      expect(posts).toEqual([7])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("names the Run whose failed post may have landed, beside the review it keeps", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () => Effect.succeed(prView(7, headCommit, baseCommit)),
        viewClosingIssues: () => Effect.succeed([]),
        postComment: () =>
          Effect.fail(new GitHubError({ operation: "post", reason: "gh timed out" })),
      })

      const reviewed = yield* review(
        fixture,
        successfulScripted(),
        {
          target: SubmissionTargetRequest.PullRequest({ number: 7, githubSpecOnly: false }),
          destination: "pr",
        },
        github,
      )
      expect(reviewed.digest).toContain("1 confirmed")
      expect(reviewed.delivery).toEqual(
        Result.fail(
          new Run.RunRefusal({
            reason: "could not deliver — gh timed out",
            unconfirmedPost: reviewed.runId,
          }),
        ),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

describe("Run refusals", () => {
  const refusalOf = (
    fixture: Fixture,
    fields: Partial<Run.ReviewRequest> = {},
  ) =>
    review(fixture, makeScripted({ sessions: [] }), fields).pipe(Effect.flip)

  it.effect("refuses before any Run or paid work, with a reason every Host shows as it stands", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const missing = path.join(fixture.home, "missing.md")
      expect((yield* refusalOf(fixture, { specPath: missing })).reason).toBe(
        `could not review — caller addendum file does not exist (${missing})`,
      )
      const empty = path.join(fixture.home, "empty.md")
      yield* fs.writeFileString(empty, "  \n\n")
      expect((yield* refusalOf(fixture, { specPath: empty })).reason).toBe(
        `could not review — caller addendum is empty (${empty})`,
      )
      yield* writeSettings(fixture, { "default-recipe": "fixture-recipe", favorites: [] })
      expect((yield* refusalOf(fixture, { selectedLensNames: undefined })).reason)
        .toContain(fixture.settingsFile)
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("words a filesystem failure as its operation, path and reason", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      // A file where the runs root belongs: the run directory cannot be made.
      yield* fs.writeFileString(fixture.runsRoot, "not a directory\n")

      expect((yield* refusalOf(fixture)).reason).toBe(
        `could not review — FileSystem.makeDirectory failed on ${fixture.runsRoot}: AlreadyExists (EEXIST)`,
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses to deliver a Run that has no pull request", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const reviewed = yield* review(fixture, successfulScripted())

      const refusal = yield* Run.deliver(reviewed.runId).pipe(
        provideReviewFixture(fixture, makeScripted({ sessions: [] })),
        Effect.flip,
      )
      expect(refusal.reason).toBe(
        `could not deliver — run ${reviewed.runId} is not a pull-request review and has no pull-request destination`,
      )
      expect(refusal.unconfirmedPost).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
