import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ReviewPlan } from "../domain/review-plan.ts"
import {
  gitHubLayer,
  unusedGitHubContract,
  type GitHubClosingIssue,
  type GitHubIssueComment,
  type PullRequestView,
} from "../github/github.ts"
import type {
  LinearBranchIssue,
  LinearCommentSnapshot,
  LinearIssueSnapshot,
} from "../linear/linear.ts"
import { chompLine, runGit } from "../target/git.ts"
import { commitAll, makeGitFixture } from "./git.fixture.ts"

// The shared review fixture: a real temp git repository, a temp HOME with
// settings and a recipe catalog, and a fixture content directory standing in
// for the shipped Lens catalog and prompt templates. Used by both the CLI
// journey suite and the Submission suite.

export interface Fixture {
  readonly repo: string
  readonly home: string
  readonly content: string
  readonly runsRoot: string
  readonly recipesDirectory: string
  readonly settingsFile: string
}

export const FIXTURE_SEAT = "fixture/fixture-model:low"

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Json))

export const writeRecipe = (
  fixture: Fixture,
  name: string,
  recipe: Schema.Json,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const json = yield* encodeJson(recipe)
    yield* fs.writeFileString(
      path.join(fixture.recipesDirectory, `${name}.json`),
      `${json}\n`,
    )
  })

export const writeSettings = (fixture: Fixture, settings: Schema.Json) =>
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

export const makeFixture = Effect.gen(function* () {
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
    "default-lenses": ["fixture-review"],
    favorites: [],
  })
  return fixture
})

export const makeDirtyRepo = Effect.gen(function* () {
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

export const makePrReviewFixture = Effect.gen(function* () {
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

// A trunk commit, then a `feature` branch with one commit on top. The
// committed line is the same needle the working-tree fixtures use, so the
// finder script and its candidates are shared.
export const makeCommitRangeFixture = Effect.gen(function* () {
  const fixture = yield* makeFixture
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  yield* fs.writeFileString(path.join(fixture.repo, "alpha.txt"), "first line\n")
  yield* commitAll(fixture.repo, "base")
  const mergeBase = chompLine(
    yield* runGit(fixture.repo, ["rev-parse", "HEAD"]),
  )
  const trunk = chompLine(
    yield* runGit(fixture.repo, ["branch", "--show-current"]),
  )
  yield* runGit(fixture.repo, ["switch", "-c", "feature"])
  yield* fs.writeFileString(
    path.join(fixture.repo, "alpha.txt"),
    "first line\nneedle-added-line\n",
  )
  yield* commitAll(fixture.repo, "feature work")
  const headCommit = chompLine(
    yield* runGit(fixture.repo, ["rev-parse", "HEAD"]),
  )
  return { fixture, headCommit, mergeBase, trunk }
})

export const prView = (
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

export const issueUrl = (number: number) =>
  `https://github.com/example/repo/issues/${String(number)}`

export const githubComment = (
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

export const closingIssue = (
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

export const githubForPr = (
  view: PullRequestView,
  issues: ReadonlyArray<GitHubClosingIssue>,
) =>
  gitHubLayer({
    ...unusedGitHubContract,
    viewPullRequest: () => Effect.succeed(view),
    viewClosingIssues: () => Effect.succeed(issues),
  })

export const linearComment = (
  body: string,
  createdAt: string,
  isBot = false,
): LinearCommentSnapshot => ({
  url: `https://linear.app/example/comment/${body.replaceAll(" ", "-")}`,
  body,
  createdAt,
  isBot,
})

export const linearIssue = (
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

export const linearBranchIssue = (): LinearBranchIssue => ({
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

export const readOnlyRunPlan = (fixture: Fixture) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const [runId = ""] = yield* fs.readDirectory(fixture.runsRoot)
    const plan = yield* fs.readFileString(
      path.join(fixture.runsRoot, runId, "plan.json"),
    ).pipe(
      Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(ReviewPlan))),
    )
    return { plan, runId }
  })
