import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Command from "effect/cli/Command"
import type { ReviewRequest } from "../run/run.ts"
import { SubmissionTargetRequest } from "../run/submission.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import { reviewSyntax } from "./syntax.ts"

// The words both Hosts take, as the request or refusal each becomes.

const parse = (words: ReadonlyArray<string>, relatedFiles: boolean) => {
  let parsed: ReviewRequest | string | undefined
  const gauntlet = Command.make("gauntlet").pipe(
    Command.withSubcommands(reviewSyntax({ relatedFiles }, {
      review: (request) =>
        Effect.sync(() => {
          parsed = request
        }),
      deliver: (runId) =>
        Effect.sync(() => {
          parsed = `deliver ${runId}`
        }),
    })),
  )
  return Command.runWith(gauntlet, { version: "0.0.0-test" })(words).pipe(
    Effect.map(() => parsed),
    Effect.catchTags({
      ReviewCommandError: (refusal) => Effect.succeed(refusal.reason),
      ShowHelp: (help) =>
        Effect.succeed(help.errors.map((error) => error.message).join("; ")),
    }),
    Effect.provideService(InvocationDirectory, "/work/repo"),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/home/me" })),
      ),
    ),
  )
}

const workingTree = SubmissionTargetRequest.WorkingTree({ base: undefined })
const pullRequest = (number: number, githubSpecOnly = false) =>
  SubmissionTargetRequest.PullRequest({ number, githubSpecOnly })

const AIMED_HEAD =
  "--working-tree extends only a commit base; a pull request or a <base>..<head> range has its own head"

const table: ReadonlyArray<{
  readonly words: ReadonlyArray<string>
  readonly relatedFiles?: boolean
  readonly becomes: Partial<ReviewRequest> | string
}> = [
  { words: ["review"], becomes: { target: workingTree, directory: "/work/repo", relatedFiles: false } },
  { words: ["review", "--working-tree"], becomes: { target: workingTree } },
  {
    words: ["review", "12", "--recipe", "high"],
    becomes: { target: pullRequest(12), recipeName: Option.some("high") },
  },
  {
    words: ["review", "abc~1..abc"],
    becomes: { target: SubmissionTargetRequest.Commits({ range: "abc~1..abc" }) },
  },
  {
    words: ["review", "main", "--working-tree"],
    becomes: { target: SubmissionTargetRequest.WorkingTree({ base: "main" }) },
  },
  {
    words: ["review", "--recipe=high", "--lenses", "a, b", "--github-spec", "7", "--destination", "pr"],
    becomes: {
      target: pullRequest(7, true),
      recipeName: Option.some("high"),
      selectedLensNames: ["a", "b"],
      destination: "pr",
    },
  },
  {
    words: ["review", "--repo", "~/other", "--spec", "notes.md"],
    becomes: { directory: "/home/me/other", specPath: "/work/repo/notes.md" },
  },
  { words: ["review"], relatedFiles: true, becomes: { relatedFiles: true } },
  { words: ["review", "--no-related-files"], relatedFiles: true, becomes: { relatedFiles: false } },
  { words: ["review", "12", "--working-tree"], becomes: AIMED_HEAD },
  { words: ["review", "main..topic", "--working-tree"], becomes: AIMED_HEAD },
  { words: ["review", "--destination", "pr"], becomes: "--destination pr needs a pull request target" },
  { words: ["review", "main", "--github-spec"], becomes: "--github-spec needs a pull request target" },
  { words: ["review", "--pr", "12"], becomes: "Unrecognized flag: --pr in command gauntlet review" },
  { words: ["deliver", "run-1"], becomes: "deliver run-1" },
]

describe("the shared review syntax", () => {
  it.effect("turns each Host's words into the same request, or the same refusal", () =>
    Effect.gen(function* () {
      for (const { becomes, relatedFiles = false, words } of table) {
        const parsed = yield* parse(words, relatedFiles)
        if (Predicate.isString(becomes)) expect(parsed, words.join(" ")).toBe(becomes)
        else expect(parsed, words.join(" ")).toMatchObject(becomes)
      }
    }))
})
