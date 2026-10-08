import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import * as TestConsole from "effect/testing/TestConsole"
import {
  gitHubLayer,
  unusedGitHubContract,
  unusedGitHubLayer,
} from "../github/github.ts"
import { makeScripted, type Scripted, usageRow } from "../harness/scripted.ts"
import {
  emittingSession,
  FINDER_OUTPUT,
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
import { InvocationDirectory } from "../target/invocation-directory.ts"
import * as Run from "./run.ts"
import { type RunMilestone, RunMilestones } from "./run-milestones.ts"
import { SubmissionTargetRequest } from "./submission.ts"

// The Run module's interface is the test seam for a Run's lifecycle
// (ADR 0007): each case asks for a review or a delivery and asserts on what
// comes back, and on the run directory where the answer points.

const review = (
  fixture: Fixture,
  scripted: Scripted,
  fields: Partial<Run.ReviewRequest> = {},
  github = unusedGitHubLayer,
) =>
  Run.review({
    directory: fixture.repo,
    target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
    recipeName: Option.none(),
    selectedLensNames: ["fixture-review"],
    specPath: undefined,
    relatedFiles: false,
    destination: "local",
    ...fields,
  }).pipe(
    // Run from outside the checkout: the request's directory is where the
    // review runs.
    Effect.provideService(InvocationDirectory, fixture.home),
    provideReviewFixture(fixture, scripted, github),
  )

describe("Run.review", () => {
  it.effect("answers a review's run id, Dossier paths and digest, reporting its milestones on the way", () =>
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

  it.effect("answers a failed Judgment as a short coverage gap, keeping its provider diagnostics in run.log", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const reviewed = yield* review(
        fixture,
        makeScripted({
          sessions: [
            emittingSession(FINDER_OUTPUT),
            emittingSession(VERIFIER_OUTPUT, "-verification"),
            {
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
            },
          ],
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

  it.effect("shows the caller addendum to verification and judgment, never to a specific finder", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // The addendum lives outside the reviewed repository, per the
      // invoking-agent skill's guidance.
      const addendumPath = path.join(fixture.home, "addendum.md")
      const needle = "ADDENDUM-REQUIREMENT: alpha.txt must stay sorted"
      yield* fs.writeFileString(addendumPath, `${needle}\n`)
      const scripted = successfulScripted()
      yield* review(fixture, scripted, { specPath: addendumPath })

      const [finderSystemPrompt = ""] = systemPromptsFor(scripted, "-finders")
      expect(finderSystemPrompt).not.toContain(needle)
      // After the diff, before what the stage decides on.
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

  it.effect("refuses before any Run, saying when there is no configuration to choose from", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const refusalOf = (fields: Partial<Run.ReviewRequest>) =>
        review(fixture, makeScripted({ sessions: [] }), fields).pipe(Effect.flip)

      const missing = path.join(fixture.home, "missing.md")
      expect(yield* refusalOf({ specPath: missing })).toEqual(
        new Run.RunRefusal({
          reason: `could not review — caller addendum file does not exist (${missing})`,
        }),
      )
      yield* fs.remove(fixture.settingsFile)
      expect(
        yield* refusalOf({ selectedLensNames: undefined, recipeName: Option.some("fixture-recipe") }),
      ).toMatchObject({
        reason: "could not review — no Default Lenses are configured and the review names no Lenses",
        unconfigured: true,
      })
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

// A failed post's unconfirmed Run is the CLI suite's deliver journey
// (src/cli/main.test.ts), which words exactly that field.
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
      expect(reviewed.delivery).toEqual(
        Result.succeed(expect.objectContaining({ url })),
      )

      const again = yield* Run.deliver(reviewed.runId).pipe(
        provideReviewFixture(fixture, makeScripted({ sessions: [] }), github),
      )
      expect(again.url).toBe(url)
      expect(posts).toEqual([7])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses to deliver a Run that has no pull request", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const reviewed = yield* review(fixture, successfulScripted())

      const refusal = yield* Run.deliver(reviewed.runId).pipe(
        provideReviewFixture(fixture, makeScripted({ sessions: [] })),
        Effect.flip,
      )
      expect(refusal).toEqual(
        new Run.RunRefusal({
          reason: `could not deliver — run ${reviewed.runId} is not a pull-request review and has no pull-request destination`,
        }),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
