import * as Effect from "effect/Effect"
import * as Option from "effect/Option"
import { ReviewTarget } from "../domain/review-target.ts"
import { GitHub, type GitHubError } from "../github/github.ts"
import {
  chompLine,
  describeGitFailure,
  type GitCommandError,
  runGit,
} from "./git.ts"
import {
  gitlinkPaths,
  submoduleWarning,
  TargetUnresolvable,
} from "./working-tree.ts"

const explainGit = (reason: string) =>
<A, R>(self: Effect.Effect<A, GitCommandError, R>): Effect.Effect<A, TargetUnresolvable, R> =>
  Effect.catchTag(self, "GitCommandError", (cause) =>
    Effect.fail(
      new TargetUnresolvable({
        reason: describeGitFailure(reason, cause),
        cause,
      }),
    ))

const explainGitHub = (number: number) =>
<A, R>(self: Effect.Effect<A, GitHubError, R>): Effect.Effect<A, TargetUnresolvable, R> =>
  self.pipe(
    Effect.mapError((cause) =>
      new TargetUnresolvable({
        reason: `could not resolve PR #${String(number)}: ${cause.reason}`,
        cause,
      })),
  )

// rev-parse --verify fails with a non-zero exit when the object is absent;
// a spawn failure (git missing) is a different truth and stays unresolvable.
const existingCommit = Effect.fn("gauntlet.pull_request.existing_commit")(
  function* (repoRoot: string, oid: string) {
    return yield* runGit(repoRoot, ["rev-parse", "--verify", `${oid}^{commit}`])
      .pipe(
        Effect.map((out) => Option.some(chompLine(out))),
        Effect.catchTag("GitCommandError", (cause) =>
          cause.exitCode === undefined
            ? Effect.fail(
              new TargetUnresolvable({
                reason: describeGitFailure(
                  `could not resolve commit ${oid}`,
                  cause,
                ),
                cause,
              }),
            )
            : Effect.succeed(Option.none<string>())),
      )
  },
)

const resolveCommit = Effect.fn("gauntlet.pull_request.resolve_commit")(
  function* (
    repoRoot: string,
    oid: string,
    fetchArgs: ReadonlyArray<string>,
    missingReason: string,
  ) {
    const local = yield* existingCommit(repoRoot, oid)
    if (Option.isSome(local)) return local.value
    yield* runGit(repoRoot, fetchArgs).pipe(explainGit(missingReason))
    const fetched = yield* existingCommit(repoRoot, oid)
    if (Option.isSome(fetched)) return fetched.value
    return yield* new TargetUnresolvable({
      reason: missingReason,
      cause: undefined,
    })
  },
)

// Resolves `--pr N` to that PR's range. A PR target means its head commit
// by definition; there is no fallback to the working tree (ADR 0005).
export const resolvePullRequestTarget = Effect.fn(
  "gauntlet.pull_request.resolve_pull_request_target",
)(function* (directory: string, number: number) {
  const github = yield* GitHub
  const repoRoot = yield* runGit(directory, ["rev-parse", "--show-toplevel"]).pipe(
    explainGit("not inside a git repository"),
    Effect.map(chompLine),
  )
  const view = yield* github.viewPullRequest(repoRoot, number).pipe(
    explainGitHub(number),
  )
  const headCommit = yield* resolveCommit(
    repoRoot,
    view.headRefOid,
    ["fetch", "origin", `refs/pull/${String(number)}/head`],
    `could not resolve PR #${String(number)} head ${view.headRefOid}`,
  )
  const baseTip = yield* resolveCommit(
    repoRoot,
    view.baseRefOid,
    ["fetch", "origin", view.baseRefName],
    `could not resolve PR #${String(number)} base ${view.baseRefOid}`,
  )
  const baseCommit = yield* runGit(repoRoot, ["merge-base", baseTip, headCommit])
    .pipe(
      explainGit(`could not resolve merge-base for PR #${String(number)}`),
      Effect.map(chompLine),
    )
  const [diff, changedFiles, submodules] = yield* Effect.all(
    [
      runGit(repoRoot, ["diff", baseCommit, headCommit]).pipe(
        explainGit(`could not diff PR #${String(number)}`),
      ),
      runGit(repoRoot, ["diff", "--name-only", "-z", baseCommit, headCommit]).pipe(
        explainGit(`could not list changed files for PR #${String(number)}`),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
      runGit(repoRoot, ["ls-tree", "-r", "-z", headCommit]).pipe(
        explainGit(`could not list the tree of PR #${String(number)}`),
        Effect.map(gitlinkPaths),
      ),
    ],
    { concurrency: 2 },
  )

  if (diff === "") {
    return yield* new TargetUnresolvable({
      reason: `PR #${String(number)} has no changes to review`,
      cause: undefined,
    })
  }

  return ReviewTarget.cases.PullRequest.make({
    repoRoot,
    number,
    headCommit,
    baseCommit,
    changedFiles,
    diff,
    warnings: submoduleWarning(submodules),
  })
})
