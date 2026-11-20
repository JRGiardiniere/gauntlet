import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { pipe } from "effect/Function"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { ContentDirectory } from "../content/lens.ts"
import {
  gitHubLayer,
  unusedGitHubContract,
  unusedGitHubLayer,
  type PullRequestView,
} from "../github/github.ts"
import type { FindingsOutput } from "../harness/output-contract.ts"
import {
  // oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- builds the scripted test Host's script state, not a service
  makeScripted,
  scriptedLayer,
  type Scripted,
  type ScriptedSession,
} from "../harness/scripted.ts"
import { FinderCacheSettle } from "../run/finder-execution.ts"
import type { JudgmentsOutput } from "../stages/judgment/output-contract.ts"
import type { VerdictsOutput } from "../stages/verification/output-contract.ts"
import { chompLine, runGit } from "../target/git.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
// oxlint-disable-next-line anti-slop-effect/no-service-constructor-imports -- a test fixture factory, not a service constructor
import { commitAll, makeGitFixture } from "./git.fixture.ts"
import { untouchedHostLayer } from "../host/host.ts"

// The shared review fixture: a real temp git repository, a temp HOME with
// settings and a recipe catalog, and a fixture content directory standing in
// for the shipped Lens catalog and the finder and workspace prompts (Pool,
// Verification and Judgment read their own shipped templates), plus scripted
// Stage sessions. Used by the CLI suite, the Run suite and the Submission
// suite.

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
{{WORKSPACE_TOOLS}}
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
    "fixture finder system prompt, emitting with {{EMIT_TOOL}}\n",
  )
  yield* fs.writeFileString(
    path.join(content, "prompts", "finder-shared-block.md"),
    SHARED_PROMPT,
  )
  yield* fs.writeFileString(
    path.join(content, "prompts", "workspace.md"),
    "fixture workspace tools at {{REPO_ROOT}}\n",
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
  const baseCommit = yield* runGit(fixture.repo, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))
  yield* fs.writeFileString(
    path.join(fixture.repo, "alpha.txt"),
    "first line\nneedle-added-line\n",
  )
  yield* commitAll(fixture.repo, "head")
  const headCommit = yield* runGit(fixture.repo, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))

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
  const mergeBase = yield* runGit(fixture.repo, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))
  const trunk = yield* runGit(fixture.repo, ["branch", "--show-current"]).pipe(Effect.map(chompLine))
  yield* runGit(fixture.repo, ["switch", "-c", "feature"])
  yield* fs.writeFileString(
    path.join(fixture.repo, "alpha.txt"),
    "first line\nneedle-added-line\n",
  )
  yield* commitAll(fixture.repo, "feature work")
  const headCommit = yield* runGit(fixture.repo, ["rev-parse", "HEAD"]).pipe(Effect.map(chompLine))

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

export const githubForPr = (view: PullRequestView) =>
  gitHubLayer({
    ...unusedGitHubContract,
    viewPullRequest: () => Effect.succeed(view),
  })

// Everything a review needs around the fixture: its HOME, content and
// repository, the scripted Host and a GitHub fake, with no cache settle to
// wait out.
export const provideReviewFixture = (
  fixture: Fixture,
  scripted: Scripted,
  github = unusedGitHubLayer,
) =>
<A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(InvocationDirectory, fixture.repo),
    Effect.provideService(ContentDirectory, fixture.content),
    Effect.provideService(FinderCacheSettle, Effect.void),
    Effect.provide([
      NodeServices.layer,
      ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: fixture.home })),
      scriptedLayer(scripted),
      github,
      untouchedHostLayer,
    ]),
  )

export const FINDER_OUTPUT = {
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

// The stage outputs a scripted session can emit. The harness keeps emit args
// `unknown` because it is a generic adapter seam; naming the admissible
// domain outputs means a script can only emit decodable model output.
type EmittedOutput = FindingsOutput | VerdictsOutput | JudgmentsOutput

// A session whose one turn emits its output, after `toolCalls` inspection
// calls. The BugClaim and Judgment paths execute concurrently, so a session
// named for an invocation's id suffix is claimed by it; an unnamed one is
// claimed in open order.
export const emittingSession = (
  output: EmittedOutput,
  forSession?: string,
  toolCalls = 0,
): ScriptedSession => {
  const turns = [{ emits: [output], toolCalls: { total: toolCalls, errored: 0 } }]

  return forSession === undefined ? { turns } : { turns, forSession }
}

export const VERIFIER_OUTPUT = {
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

export const JUDGMENT_OUTPUT = {
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

// Concurrent sessions interleave their prompt calls, so prompts are asserted
// by invocation identity, never by global order.
export const promptTextsFor = (scripted: Scripted, suffix: string): Array<string> =>
  pipe(
    scripted.prompts,
    Array.filter(({ invocationId }) => invocationId.includes(suffix)),
    Array.map(({ text }) => text),
  )

// The finder shared block rides in the system prompt; the user message is
// only the lens tail.
export const systemPromptsFor = (scripted: Scripted, suffix: string): Array<string> =>
  pipe(
    scripted.prompts,
    Array.filter(({ invocationId }) => invocationId.includes(suffix)),
    Array.map(({ openIndex }) => scripted.specs[openIndex - 1]?.systemPrompt ?? ""),
  )

// A Finder, a verifier and a judge that each emit their stage's fixture
// output.
export const successfulScripted = (): Scripted =>
  makeScripted({
    sessions: [
      emittingSession(FINDER_OUTPUT),
      emittingSession(VERIFIER_OUTPUT, "-verification"),
      emittingSession(JUDGMENT_OUTPUT, "-judgment"),
    ],
  })
