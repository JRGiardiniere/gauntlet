import * as Config from "effect/Config"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Argument from "effect/cli/Argument"
import * as Command from "effect/cli/Command"
import * as Flag from "effect/cli/Flag"
import type { ReviewRequest } from "../run/run.ts"
import { SubmissionTargetRequest } from "../run/submission.ts"
import { InvocationDirectory } from "../target/invocation-directory.ts"

// The one command syntax both Hosts parse (#159): the CLI the words after
// `gauntlet`, the Mod the words after `/gauntlet`.
//
//   review [target] [--working-tree] [--recipe <name>] [--lenses <a,b>]
//          [--spec <file>] [--github-spec] [--related-files | --no-related-files]
//          [--destination local|pr] [--repo <path>]
//   deliver <run-id>
//
// A Host hands in what it does with a parsed review request and its
// destination, and with a run id: the words become the Run module's typed
// request here and nowhere else.

// A review whose words parse but ask for something no review can be.
export class ReviewCommandError extends Data.TaggedError("ReviewCommandError")<{
  readonly reason: string
}> {}

// Where a review's Dossier goes: local stays in the run directory, pr is also
// posted on the reviewed pull request, by the Host delivering the Run once it
// has shown the digest.
export type Destination = "local" | "pr"

export interface HostVerbs<E, R> {
  readonly review: (
    request: ReviewRequest,
    destination: Destination,
  ) => Effect.Effect<void, E, R>
  readonly deliver: (runId: string) => Effect.Effect<void, E, R>
}

interface ReviewInput {
  readonly target: Option.Option<string>
  readonly workingTree: boolean
  readonly recipe: Option.Option<string>
  readonly lenses: Option.Option<string>
  readonly spec: Option.Option<string>
  readonly githubSpec: boolean
  readonly relatedFiles: boolean
  readonly destination: Destination
  readonly repo: Option.Option<string>
}

// A path as the person wrote it: `~/…` from HOME, which the Mod's words reach
// unexpanded, anything else from where the command runs.
const resolveWritten = Effect.fn("Syntax.resolvePath")(function* (
  written: string,
) {
  const path = yield* Path.Path
  if (written !== "~" && !written.startsWith("~/")) {
    return path.resolve(yield* InvocationDirectory, written)
  }
  const home = yield* Config.String("HOME").pipe(
    Effect.mapError(() =>
      new ReviewCommandError({ reason: `HOME is not set, so ${written} names no folder` })
    ),
  )
  return path.join(home, written.slice(1))
})

const reviewRequestOf = Effect.fn("Syntax.reviewRequest")(function* (
  input: ReviewInput,
) {
  const target = Option.getOrUndefined(input.target)
  // All digits is a pull request; anything else is a commit range as git
  // takes it, `<base>` meaning merge-base(base, HEAD)..HEAD.
  const pullRequest = target !== undefined && /^\d+$/.test(target)
    ? Number(target)
    : undefined
  if (
    input.workingTree &&
    (pullRequest !== undefined || target?.includes("..") === true)
  ) {
    return yield* new ReviewCommandError({
      reason:
        "--working-tree extends only a commit base; a pull request or a <base>..<head> range has its own head",
    })
  }
  if (input.destination === "pr" && pullRequest === undefined) {
    return yield* new ReviewCommandError({
      reason: "--destination pr needs a pull request target",
    })
  }
  if (input.githubSpec && pullRequest === undefined) {
    return yield* new ReviewCommandError({
      reason: "--github-spec needs a pull request target",
    })
  }
  return {
    directory: Option.isSome(input.repo)
      ? yield* resolveWritten(input.repo.value)
      : yield* InvocationDirectory,
    target: pullRequest !== undefined
      ? SubmissionTargetRequest.PullRequest({
        number: pullRequest,
        githubSpecOnly: input.githubSpec,
      })
      : target === undefined
      ? SubmissionTargetRequest.WorkingTree({ base: undefined })
      : input.workingTree
      ? SubmissionTargetRequest.WorkingTree({ base: target })
      : SubmissionTargetRequest.Commits({ range: target }),
    recipeName: input.recipe,
    selectedLensNames: Option.isNone(input.lenses)
      ? undefined
      : input.lenses.value.split(",").map((name) => name.trim()),
    specPath: Option.isSome(input.spec)
      ? yield* resolveWritten(input.spec.value)
      : undefined,
    relatedFiles: input.relatedFiles,
  } satisfies ReviewRequest
})

// The review and deliver commands, with the Host's default for related files
// (the CLI's off, the Mod's on) and what the Host does with each.
export const reviewSyntax = <E, R>(
  defaults: { readonly relatedFiles: boolean },
  verbs: HostVerbs<E, R>,
) =>
  [
    Command.make(
      "review",
      {
        target: Argument.String("target").pipe(
          Argument.optional,
          Argument.withDescription(
            "A pull request number, or a commit range as git takes it: <base> reviews merge-base(base, HEAD)..HEAD, <base>..<head> that range, abc~1..abc one commit. Omitted, the uncommitted changes against HEAD",
          ),
        ),
        workingTree: Flag.Boolean("working-tree").pipe(
          Flag.withDefault(false),
          Flag.withDescription(
            "With a <base> target, extend that range to the current uncommitted work",
          ),
        ),
        recipe: Flag.String("recipe").pipe(
          Flag.optional,
          Flag.withMetavar("<name>"),
          Flag.withDescription(
            "Named recipe from the catalog; omit to use the configured default-recipe",
          ),
        ),
        lenses: Flag.String("lenses").pipe(
          Flag.optional,
          Flag.withMetavar("<a,b>"),
          Flag.withDescription(
            "Use exactly these comma-separated Lenses instead of Default Lenses",
          ),
        ),
        spec: Flag.String("spec").pipe(
          Flag.optional,
          Flag.withMetavar("<markdown-file>"),
          Flag.withDescription(
            "Caller Addendum: a Markdown requirements file frozen into the plan and shown to interpretive finders, verification, and judgment",
          ),
        ),
        githubSpec: Flag.Boolean("github-spec").pipe(
          Flag.withDefault(false),
          Flag.withDescription(
            "Use only GitHub closing issues as the automatic ReviewSpecification source for this Run",
          ),
        ),
        relatedFiles: Flag.Boolean("related-files").pipe(
          Flag.withDefault(defaults.relatedFiles),
          Flag.withDescription(
            "Also show Finders every touched file whole, plus the unchanged files that import or are imported by one, tests included (--no-related-files to leave them out)",
          ),
        ),
        destination: Flag.Literals("destination", ["local", "pr"]).pipe(
          Flag.withDefault("local"),
          Flag.withDescription(
            "local writes the run directory and digest; pr also posts dossier.md on the pull request",
          ),
        ),
        repo: Flag.String("repo").pipe(
          Flag.optional,
          Flag.withMetavar("<path>"),
          Flag.withDescription(
            "Review another local checkout: absolute, ~/…, or from where the command runs",
          ),
        ),
      },
      (input) =>
        reviewRequestOf(input).pipe(
          Effect.flatMap((request) => verbs.review(request, input.destination)),
        ),
    ).pipe(
      Command.withDescription(
        "Review the uncommitted changes, a commit range, or a pull request",
      ),
    ),
    Command.make(
      "deliver",
      {
        runId: Argument.String("run-id").pipe(
          Argument.withDescription("Completed run to post"),
        ),
      },
      ({ runId }) => verbs.deliver(runId),
    ).pipe(
      Command.withDescription(
        "Post a completed pull-request run's dossier.md as a PR comment",
      ),
    ),
  ] as const
