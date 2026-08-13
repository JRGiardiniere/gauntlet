import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  chompLine,
  describeGitFailure,
  type GitCommandError,
  runGit,
} from "./git.ts"

// The working tree cannot yield a ReviewTarget at all — not a repo, no HEAD
// to diff against, or nothing changed. "Could not review", exit 1.
export class TargetUnresolvable extends Data.TaggedError("TargetUnresolvable")<{
  readonly reason: string
  readonly cause: unknown
}> {}

const explainGit = (reason: string) =>
<A, R>(self: Effect.Effect<A, GitCommandError, R>): Effect.Effect<A, TargetUnresolvable, R> =>
  Effect.catchTag(self, "GitCommandError", (cause) =>
    Effect.fail(
      new TargetUnresolvable({
        reason: describeGitFailure(reason, cause),
        cause,
      }),
    ))

// Resolves the default target: uncommitted changes vs HEAD, diff frozen at
// submission (ADR 0005 — explicit aiming, the working tree is the
// zero-thought default). Untracked files are outside the diff; they surface
// as a scope-degradation warning on the target, never silently.
export const resolveWorkingTreeTarget = Effect.fn(
  "gauntlet.working_tree.resolve_working_tree_target",
)(function* (directory: string) {
  const repoRoot = yield* runGit(directory, ["rev-parse", "--show-toplevel"]).pipe(
    explainGit("not inside a git repository"),
    Effect.map(chompLine),
  )
  const headCommit = yield* runGit(repoRoot, ["rev-parse", "HEAD"]).pipe(
    explainGit("repository has no HEAD commit to diff against"),
    Effect.map(chompLine),
  )
  // Diff against the resolved hash, not symbolic HEAD — a commit landing
  // between the two commands must not desynchronize identity and diff.
  const [diff, changedFiles, untracked] = yield* Effect.all(
    [
      runGit(repoRoot, ["diff", headCommit]).pipe(
        explainGit("could not diff the working tree against HEAD"),
      ),
      runGit(repoRoot, ["diff", "--name-only", "-z", headCommit]).pipe(
        explainGit("could not list changed files"),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
      runGit(repoRoot, ["ls-files", "--others", "--exclude-standard"]).pipe(
        explainGit("could not list untracked files"),
        Effect.map((out) => out.split("\n").filter((line) => line !== "")),
      ),
    ],
    { concurrency: 2 },
  )

  if (diff === "") {
    return yield* new TargetUnresolvable({
      reason: untracked.length === 0
        ? "working tree has no uncommitted changes to review"
        : `working tree has no uncommitted changes to review (${untracked.length} untracked file(s) are not part of the diff)`,
      cause: undefined,
    })
  }

  const warnings = untracked.length === 0
    ? []
    : [
      `${untracked.length} untracked file(s) not included in the diff: ${untracked.join(", ")}`,
    ]

  return ReviewTarget.cases.WorkingTree.make({
    repoRoot,
    headCommit,
    changedFiles,
    diff,
    warnings,
  })
})
