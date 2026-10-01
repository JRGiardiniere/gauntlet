import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { standardsManifestPath } from "../config/standards-manifest.ts"
import { ContentDirectory } from "../content/lens.ts"
import { GOVERNING_STANDARDS_HEADING } from "../domain/finder-selection.ts"
import { ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  gitHubLayer,
  unusedGitHubContract,
  unusedGitHubLayer,
} from "../github/github.ts"
import { Linear, LinearError, unusedLinearLayer } from "../linear/linear.ts"
import { runGit } from "../target/git.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import {
  closingIssue,
  FIXTURE_SEAT,
  githubComment,
  githubForPr,
  linearBranchIssue,
  makeCommitRangeFixture,
  makeDirtyRepo,
  makePrReviewFixture,
  prView,
  writeRecipe,
  writeSettings,
  type Fixture,
} from "../test-support/review.fixture.ts"
import {
  submit,
  SubmissionError,
  SubmissionTargetRequest,
  type SubmissionRequest,
} from "./submission.ts"

// The Submission suite asserts external behavior at the Submission interface
// — the returned plan and the run-directory artifacts, never resolution
// internals (issue #105).

const exactLenses = (
  target: SubmissionTargetRequest,
  names: ReadonlyArray<string> = ["fixture-review"],
): SubmissionRequest => ({
  target,
  recipeName: Option.none(),
  selectedLensNames: names,
  addendum: undefined,
})

const submitWith = (
  fixture: Fixture,
  request: SubmissionRequest,
  github = unusedGitHubLayer,
  linear = unusedLinearLayer,
) =>
  submit(request).pipe(
    Effect.provideService(InvocationDirectory, fixture.repo),
    Effect.provideService(ContentDirectory, fixture.content),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
        github,
        linear,
      ),
    ),
  )

const persistedPlan = (fixture: Fixture, runId: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const raw = yield* fs.readFileString(
      path.join(fixture.runsRoot, runId, "plan.json"),
    )
    const plan = yield* Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))(
      raw,
    )
    return { plan, raw }
  })

describe("submission", () => {
  it.effect("persists a working-tree Run: plan behind its overlay, absent keys omitted", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "untracked.txt"),
        "not in the diff\n",
      )

      const loaded = yield* submitWith(
        fixture,
        exactLenses(SubmissionTargetRequest.WorkingTree({ base: undefined })),
      )

      // Submission ends when the Run is persisted: the run directory holds
      // exactly the frozen plan and its overlay, nothing execution-shaped.
      const entries = yield* fs.readDirectory(loaded.paths.root)
      expect([...entries].sort()).toEqual([
        "plan.json",
        "workspace-overlay.patch",
      ])

      const { plan, raw } = yield* persistedPlan(fixture, loaded.plan.runId)
      expect(plan).toEqual(loaded.plan)
      expect(loaded.plan.recipeName).toBe("fixture-recipe")
      expect(loaded.plan.lenses.map(({ name, seat }) => ({ name, seat })))
        .toEqual([{ name: "fixture-review", seat: FIXTURE_SEAT }])

      expect(ReviewTarget.guards.WorkingTree(loaded.plan.target)).toBe(true)
      if (!ReviewTarget.guards.WorkingTree(loaded.plan.target)) return
      expect(loaded.plan.target.changedFiles).toEqual(["alpha.txt"])
      expect(loaded.plan.target.diff).toContain("+needle-added-line")
      expect(loaded.plan.target.untrackedFiles).toEqual(["untracked.txt"])
      expect(loaded.plan.target.warnings[0]).toContain("untracked.txt")

      const overlay = yield* fs.readFileString(loaded.paths.workspaceOverlay)
      expect(overlay).toContain("needle-added-line")
      expect(overlay).toContain("not in the diff")

      // optionalKey encoding: absent means the key is not present at all —
      // never a present-undefined one (specific-by-omission convention).
      const decoded = yield* Schema.decodeEffect(
        Schema.fromJsonString(Schema.Json),
      )(raw)
      const encoded = Predicate.isObject(decoded) ? decoded : {}
      expect(Object.keys(encoded)).not.toContain("specification")
      expect(Object.keys(encoded)).not.toContain("specificationSourceDiagnostic")
      const encodedTarget = Predicate.isObject(encoded["target"])
        ? encoded["target"]
        : {}
      expect(Object.keys(encodedTarget)).not.toContain("baseCommit")
      const encodedLenses = Array.isArray(encoded["lenses"])
        ? encoded["lenses"]
        : []
      expect(
        encodedLenses.some((lens) =>
          Predicate.isObject(lens) && "finderClass" in lens
        ),
      ).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("freezes a commit range from its resolved SHA pair with no overlay", () =>
    Effect.gen(function* () {
      const { fixture, headCommit, mergeBase, trunk } =
        yield* makeCommitRangeFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nuncommitted-line\n",
      )

      const loaded = yield* submitWith(
        fixture,
        exactLenses(SubmissionTargetRequest.Commits({ range: trunk })),
      )

      expect(ReviewTarget.guards.Commits(loaded.plan.target)).toBe(true)
      if (!ReviewTarget.guards.Commits(loaded.plan.target)) return
      expect(loaded.plan.target.baseCommit).toBe(mergeBase)
      expect(loaded.plan.target.headCommit).toBe(headCommit)
      expect(loaded.plan.target.diff).toContain("+needle-added-line")
      expect(loaded.plan.target.diff).not.toContain("uncommitted-line")
      expect(loaded.plan.target.warnings).toEqual([
        "1 uncommitted file(s) not part of this review",
      ])

      // A commit range has no uncommitted state to persist.
      expect(yield* fs.readDirectory(loaded.paths.root)).toEqual(["plan.json"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("extends a commit range to the working tree as one target", () =>
    Effect.gen(function* () {
      const { fixture, headCommit, mergeBase, trunk } =
        yield* makeCommitRangeFixture
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nuncommitted-line\n",
      )
      yield* fs.writeFileString(
        path.join(fixture.repo, "stray.txt"),
        "original-untracked\n",
      )

      const loaded = yield* submitWith(
        fixture,
        exactLenses(SubmissionTargetRequest.WorkingTree({ base: trunk })),
      )

      expect(ReviewTarget.guards.WorkingTree(loaded.plan.target)).toBe(true)
      if (!ReviewTarget.guards.WorkingTree(loaded.plan.target)) return
      // The review diff runs merge-base → working tree; the overlay stays
      // relative to the saved HEAD.
      expect(loaded.plan.target.baseCommit).toBe(mergeBase)
      expect(loaded.plan.target.headCommit).toBe(headCommit)
      expect(loaded.plan.target.diff).toContain("+needle-added-line")
      expect(loaded.plan.target.diff).toContain("+uncommitted-line")
      expect(loaded.plan.target.untrackedFiles).toEqual(["stray.txt"])
      const overlay = yield* fs.readFileString(loaded.paths.workspaceOverlay)
      expect(overlay).toContain("uncommitted-line")
      expect(overlay).not.toContain("+needle-added-line")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("resolves a pull-request target through the GitHub view", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture

      const loaded = yield* submitWith(
        fixture,
        exactLenses(
          SubmissionTargetRequest.PullRequest({
            number: 7,
            githubSpecOnly: false,
          }),
        ),
        githubForPr(prView(7, headCommit, baseCommit), []),
      )

      expect(ReviewTarget.guards.PullRequest(loaded.plan.target)).toBe(true)
      if (!ReviewTarget.guards.PullRequest(loaded.plan.target)) return
      expect(loaded.plan.target.number).toBe(7)
      expect(loaded.plan.target.baseCommit).toBe(baseCommit)
      expect(loaded.plan.target.headCommit).toBe(headCommit)
      expect(loaded.plan.target.diff).toContain("+needle-added-line")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("loads Default Lenses from settings and freezes class-resolved seats", () =>
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
      yield* writeSettings(fixture, {
        "default-recipe": "fixture-recipe",
        "default-lenses": ["fixture-review", "fixture-local"],
        favorites: [],
      })

      const loaded = yield* submitWith(fixture, {
        target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
        recipeName: Option.none(),
        selectedLensNames: undefined,
        addendum: undefined,
      })

      expect(loaded.plan.lenses.map((lens) => lens.name)).toEqual([
        "fixture-review",
        "fixture-local",
      ])
      const seatByLens = new Map(
        loaded.plan.lenses.map((lens) => [lens.name, lens.seat]),
      )
      expect(seatByLens.get("fixture-review")).toBe(FIXTURE_SEAT)
      expect(seatByLens.get("fixture-local")).toBe("fixture/local-model:medium")
      const classByLens = new Map(
        loaded.plan.lenses.map((lens) => [lens.name, lens.finderClass]),
      )
      expect(classByLens.get("fixture-review")).toBeUndefined()
      expect(classByLens.get("fixture-local")).toBe("interpretive")
      expect(loaded.plan.lenses[1]?.promptText).toBe("fixture local tail")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("uses exactly the caller's Lenses without consulting settings", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(fixture.settingsFile)

      const loaded = yield* submitWith(
        fixture,
        {
          target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
          recipeName: Option.some("fixture-recipe"),
          selectedLensNames: ["fixture-review"],
          addendum: undefined,
        },
      )
      expect(loaded.plan.lenses.map(({ name }) => name)).toEqual([
        "fixture-review",
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses to select Default Lenses when none are configured, creating no Run", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      yield* fs.remove(fixture.settingsFile)

      const refusal = yield* Effect.flip(submitWith(fixture, {
        target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
        recipeName: Option.some("fixture-recipe"),
        selectedLensNames: undefined,
        addendum: undefined,
      }))
      expect(refusal).toBeInstanceOf(SubmissionError)
      if (!Predicate.isTagged(refusal, "SubmissionError")) return
      expect(refusal.reason).toContain("no Default Lenses are configured")
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("freezes per-stage seats from the named Recipe for every stage and both finder classes", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "fixture-interpretive.md"),
        "---\nfinder-class: interpretive\n---\nfixture interpretive tail\n",
      )
      // fixture-recipe stays the configured default; naming fixture-full
      // must win (selection precedence, ADR 0005).
      yield* writeRecipe(fixture, "fixture-full", {
        default: "fixture/default-model:low",
        finders: "fixture/finder-model:low",
        "interpretive-finders": "fixture/interpretive-model:high",
        pool: "fixture/pool-model:low",
        verification: "fixture/verify-model:low",
        judgment: "fixture/judge-model:low",
      })

      const loaded = yield* submitWith(fixture, {
        target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
        recipeName: Option.some("fixture-full"),
        selectedLensNames: ["fixture-review", "fixture-interpretive"],
        addendum: undefined,
      })

      expect(loaded.plan.recipeName).toBe("fixture-full")
      expect(loaded.plan.seats).toEqual({
        pool: "fixture/pool-model:low",
        verification: "fixture/verify-model:low",
        judgment: "fixture/judge-model:low",
      })
      const seatByLens = new Map(
        loaded.plan.lenses.map((lens) => [lens.name, lens.seat]),
      )
      expect(seatByLens.get("fixture-review")).toBe("fixture/finder-model:low")
      expect(seatByLens.get("fixture-interpretive")).toBe(
        "fixture/interpretive-model:high",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  // The Specification Source permutations (preference order, comment
  // admission, budget arithmetic) are proven in src/specification/*; what
  // stays here is the run-dir observability contract — the frozen plan.json
  // records which source was resolved, its diagnostic, and that an omission
  // happened.
  it.effect("freezes a resolved Linear source into plan.json, never consulting GitHub", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      yield* createAndSwitchBranch(fixture, "john/eng-75-linear-source")
      let githubSpecificationCalls = 0
      const github = gitHubLayer({
        ...unusedGitHubContract,
        viewPullRequest: () => Effect.succeed(prView(7, headCommit, baseCommit)),
        viewClosingIssues: () => {
          githubSpecificationCalls += 1
          return Effect.succeed([
            closingIssue(74, "GitHub source", "GITHUB-SLICE-BODY"),
          ])
        },
      })
      const requested: Array<string> = []

      const loaded = yield* submitWith(
        fixture,
        exactLenses(
          SubmissionTargetRequest.PullRequest({
            number: 7,
            githubSpecOnly: false,
          }),
        ),
        github,
        Linear.Fake({
          viewIssue: (identifier) => {
            requested.push(identifier)
            return Effect.succeed(linearBranchIssue())
          },
        }),
      )

      expect(requested).toEqual(["ENG-75"])
      expect(githubSpecificationCalls).toBe(0)

      const { plan } = yield* persistedPlan(fixture, loaded.plan.runId)
      expect(plan).toEqual(loaded.plan)
      expect(plan.specification?.documents.map(({ text }) => text))
        .toContain("LINEAR-SLICE-BODY")
      expect(plan.specification?.comments.length).toBeGreaterThan(0)
      expect(plan.specificationSourceDiagnostic).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("freezes an unreachable Linear diagnostic, with and without GitHub material", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      yield* createAndSwitchBranch(fixture, "john/eng-75-linear-source")
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.repo, "alpha.txt"),
        "first line\nneedle-added-line\nuncommitted-line\n",
      )

      // No fallback source: the review is never blocked, and the diagnostic
      // is the only record of the matching branch's Linear attempt.
      const bare = yield* submitWith(
        fixture,
        exactLenses(SubmissionTargetRequest.WorkingTree({ base: undefined })),
        unusedGitHubLayer,
        missingApiKeyLinear,
      )
      const barePlan = (yield* persistedPlan(fixture, bare.plan.runId)).plan
      expect(barePlan.specification).toBeUndefined()
      expect(barePlan.specificationSourceDiagnostic?.reason).toBe(
        "missing-api-key",
      )
      expect(barePlan.specificationSourceDiagnostic?.message).toContain(
        "LINEAR_API_KEY is not set",
      )

      // A pull request falls back to GitHub closing issues and keeps the
      // diagnostic beside the fetched material.
      const fallback = yield* submitWith(
        fixture,
        exactLenses(
          SubmissionTargetRequest.PullRequest({
            number: 7,
            githubSpecOnly: false,
          }),
        ),
        githubForPr(prView(7, headCommit, baseCommit), [
          closingIssue(74, "GitHub source", "GITHUB-SLICE-BODY"),
        ]),
        missingApiKeyLinear,
      )
      const fallbackPlan =
        (yield* persistedPlan(fixture, fallback.plan.runId)).plan
      expect(fallbackPlan.specification?.documents.map(({ text }) => text))
        .toContain("GITHUB-SLICE-BODY")
      expect(fallbackPlan.specificationSourceDiagnostic?.reason).toBe(
        "missing-api-key",
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("pins GitHub, appends the caller addendum, and freezes the comment omission", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture
      // A Linear-shaped branch that the pin must leave unread.
      yield* createAndSwitchBranch(fixture, "john/eng-75-linear-source")
      let linearCalls = 0
      const parent = closingIssue(70, "parent spec", "PARENT-BODY")
      const issues = [
        closingIssue(74, "github source", "SLICE-BODY-INTACT", [
          githubComment("OWNER", "2026-01-01T00:00:00Z", "o".repeat(8_000)),
          githubComment("OWNER", "2026-01-02T00:00:00Z", "m".repeat(8_000)),
          githubComment("OWNER", "2026-01-03T00:00:00Z", "n".repeat(8_000)),
        ], parent),
      ]

      const loaded = yield* submitWith(
        fixture,
        {
          target: SubmissionTargetRequest.PullRequest({
            number: 7,
            githubSpecOnly: true,
          }),
          recipeName: Option.none(),
          selectedLensNames: ["fixture-review"],
          addendum: {
            documents: [{
              role: "caller-addendum",
              provenance: "/tmp/addendum.md",
              text: "ADDENDUM-REQUIREMENT: keep the caller note\n",
            }],
            comments: [],
          },
        },
        githubForPr(prView(7, headCommit, baseCommit), issues),
        Linear.Fake({
          viewIssue: () => {
            linearCalls += 1
            return Effect.succeed(linearBranchIssue())
          },
        }),
      )

      expect(linearCalls).toBe(0)
      const { plan } = yield* persistedPlan(fixture, loaded.plan.runId)
      expect(plan.specification?.documents.map(({ role }) => role)).toEqual([
        "parent",
        "slice",
        "caller-addendum",
      ])
      const specification = plan.specification?.documents
        .map(({ text }) => text)
        .join("\n") ?? ""
      expect(specification).not.toContain("LINEAR-SLICE-BODY")
      expect(specification).toContain("ADDENDUM-REQUIREMENT: keep the caller note")
      expect(plan.specification?.commentOmission).toBeDefined()
      expect(plan.specificationSourceDiagnostic).toBeUndefined()
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a GitHub-pinned submission with no closing issues, creating no Run", () =>
    Effect.gen(function* () {
      const { baseCommit, fixture, headCommit } = yield* makePrReviewFixture

      const refusal = yield* Effect.flip(submitWith(
        fixture,
        exactLenses(
          SubmissionTargetRequest.PullRequest({
            number: 7,
            githubSpecOnly: true,
          }),
        ),
        githubForPr(prView(7, headCommit, baseCommit), []),
      ))

      expect(refusal).toBeInstanceOf(SubmissionError)
      if (!Predicate.isTagged(refusal, "SubmissionError")) return
      expect(refusal.reason).toContain("--github-spec")
      const fs = yield* FileSystem.FileSystem
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("bakes the Standards Manifest documents into the frozen standards prompt", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "standards.md"),
        "standards fixture tail\n",
      )
      yield* fs.writeFileString(
        path.join(fixture.repo, "STANDARDS.md"),
        "REPO-RULE: no bare throws\n",
      )
      const sharedDocument = path.join(fixture.home, "shared-standards.md")
      yield* fs.writeFileString(sharedDocument, "SHARED-RULE: cite the line\n")
      yield* writeStandardsManifest(fixture, ["STANDARDS.md", sharedDocument])

      const loaded = yield* submitWith(
        fixture,
        exactLenses(SubmissionTargetRequest.WorkingTree({ base: undefined }), [
          "fixture-review",
          "standards",
        ]),
      )

      const promptByLens = new Map(
        loaded.plan.lenses.map((lens) => [lens.name, lens.promptText]),
      )
      const standardsPrompt = promptByLens.get("standards") ?? ""
      expect(standardsPrompt).toContain("standards fixture tail")
      expect(standardsPrompt).toContain(GOVERNING_STANDARDS_HEADING)
      expect(standardsPrompt).toContain("### STANDARDS.md")
      expect(standardsPrompt).toContain("REPO-RULE: no bare throws")
      expect(standardsPrompt).toContain(`### ${sharedDocument}`)
      expect(standardsPrompt).toContain("SHARED-RULE: cite the line")
      // The tail precedes the appended block; other lenses stay untouched.
      expect(standardsPrompt.indexOf("standards fixture tail")).toBeLessThan(
        standardsPrompt.indexOf(GOVERNING_STANDARDS_HEADING),
      )
      expect(promptByLens.get("fixture-review")).toBe("fixture lens tail")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("freezes an unfed standards prompt when no Standards Manifest exists", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "standards.md"),
        "standards fixture tail\n",
      )

      const loaded = yield* submitWith(
        fixture,
        exactLenses(SubmissionTargetRequest.WorkingTree({ base: undefined }), [
          "standards",
        ]),
      )

      // Frozen without the Governing standards block — selection then skips
      // it (finder-selection.test.ts owns that contract).
      expect(loaded.plan.lenses[0]?.promptText).toBe("standards fixture tail\n")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a manifest that lists a missing document, creating no Run", () =>
    Effect.gen(function* () {
      const fixture = yield* makeDirtyRepo
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      yield* fs.writeFileString(
        path.join(fixture.content, "lenses", "standards.md"),
        "standards fixture tail\n",
      )
      yield* writeStandardsManifest(fixture, ["missing-standards.md"])

      const refusal = yield* Effect.flip(submitWith(
        fixture,
        exactLenses(SubmissionTargetRequest.WorkingTree({ base: undefined }), [
          "standards",
        ]),
      ))

      expect(refusal).toBeInstanceOf(SubmissionError)
      if (!Predicate.isTagged(refusal, "SubmissionError")) return
      expect(refusal.reason).toContain("Standards Manifest")
      expect(refusal.reason).toContain("missing-standards.md")
      expect(yield* fs.exists(fixture.runsRoot)).toBe(false)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})

// The manifest lands at the exact path the module derives (and `gauntlet
// config` prints), so the test exercises the same location a user configures.
const writeStandardsManifest = (
  fixture: Fixture,
  entries: ReadonlyArray<string>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const manifest = yield* standardsManifestPath(fixture.repo)
    yield* fs.makeDirectory(path.dirname(manifest), { recursive: true })
    yield* fs.writeFileString(manifest, `${entries.join("\n")}\n`)
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
      ),
    ),
  )

const createAndSwitchBranch = (fixture: Fixture, branch: string) =>
  runGit(fixture.repo, ["switch", "-c", branch])

const missingApiKeyLinear = Linear.Fake({
  viewIssue: () =>
    Effect.fail(
      new LinearError({
        reason: "missing-api-key",
        detail: "LINEAR_API_KEY is not set",
      }),
    ),
})
