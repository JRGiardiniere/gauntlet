import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import { pipe } from "effect/Function"
import * as Option from "effect/Option"
import * as Predicate from "effect/Predicate"
import * as Command from "effect/cli/Command"
import type { ReviewRequest } from "../run/run.ts"
import { SubmissionTargetRequest } from "../run/submission.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"
import { type Destination, reviewSyntax } from "./syntax.ts"

// The words the CLI takes, as the request or refusal each becomes.

// A parsed review as the CLI receives it: the request and its destination.
type Parsed = ReviewRequest & { readonly destination: Destination }

const parse = (words: ReadonlyArray<string>) => {
  let parsed: Parsed | string | undefined

  const gauntlet = Command.make("gauntlet").pipe(
    Command.withSubcommands(reviewSyntax({
      review: (request, destination) =>
        Effect.sync(() => {
          parsed = { ...request, destination }
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
        Effect.succeed(pipe(help.errors, Array.map((error) => error.message), Array.join("; "))),
    }),
    Effect.provideService(InvocationDirectory, "/work/repo"),
    Effect.provide([
      NodeServices.layer,
      ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: "/home/me" })),
    ]),
  )
}

const workingTree = SubmissionTargetRequest.WorkingTree({ base: undefined })

const pullRequest = (number: number) => SubmissionTargetRequest.PullRequest({ number })

const AIMED_HEAD =
  "--working-tree extends only a commit base; a pull request or a <base>..<head> range has its own head"

const table: ReadonlyArray<{
  readonly words: ReadonlyArray<string>
  readonly becomes: Partial<Parsed> | string
}> = [
  {
    words: ["review"],
    becomes: { target: workingTree, directory: "/work/repo", relatedFiles: false, destination: "local" },
  },
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
    words: ["review", "--recipe=high", "--lenses", "a, b", "7", "--destination", "pr"],
    becomes: {
      target: pullRequest(7),
      recipeName: Option.some("high"),
      selectedLensNames: ["a", "b"],
      destination: "pr",
    },
  },
  {
    words: ["review", "--repo", "~/other", "--spec", "notes.md"],
    becomes: { directory: "/home/me/other", specPath: "/work/repo/notes.md" },
  },
  { words: ["review", "--related-files"], becomes: { relatedFiles: true } },
  { words: ["review", "--no-related-files"], becomes: { relatedFiles: false } },
  { words: ["review", "12", "--working-tree"], becomes: AIMED_HEAD },
  { words: ["review", "main..topic", "--working-tree"], becomes: AIMED_HEAD },
  { words: ["review", "--destination", "pr"], becomes: "--destination pr needs a pull request target" },
  { words: ["review", "7", "--github-spec"], becomes: "Unrecognized flag: --github-spec in command gauntlet review" },
  { words: ["review", "--pr", "12"], becomes: "Unrecognized flag: --pr in command gauntlet review" },
  { words: ["deliver", "run-1"], becomes: "deliver run-1" },
]

describe("the review syntax", () => {
  it.effect("turns the CLI's words into a request, or a refusal", () =>
    Effect.gen(function* () {
      for (const { becomes, words } of table) {
        const parsed = yield* parse(words)

        if (Predicate.isString(becomes)) expect(parsed, Array.join(words, " ")).toBe(becomes)
        else expect(parsed, Array.join(words, " ")).toMatchObject(becomes)
      }
    }))
})
