import * as Effect from "effect/Effect"
import { ReviewTarget } from "../domain/review-target.ts"
import {
  chompLine,
  explainGit,
  gitlinkPaths,
  mergeBaseOf,
  resolveCommittish,
  runGit,
  submoduleWarning,
  TargetUnresolvable,
} from "./git.ts"

// `<base>[..<head>]`: the head end defaults to HEAD, and either end accepts
// any committish (ADR 0005).
const splitRange = (spec: string) => {
  const separator = spec.indexOf("..")
  return separator === -1
    ? { base: spec, head: "HEAD" }
    : {
      base: spec.slice(0, separator),
      head: spec.slice(separator + 2) || "HEAD",
    }
}

// Resolves `--commits <base>[..<head>]` to that committed range. It mirrors
// the PullRequest target's mechanics: both ends resolve to SHAs here, the
// diff base is their merge-base, and the frozen identity is that SHA pair —
// the submitted expressions are discarded. The reviewed tree is the head
// commit's, so uncommitted edits are named in a warning, never inferred in.
export const resolveCommitsTarget = Effect.fn(
  "gauntlet.commits.resolve_commits_target",
)(function* (directory: string, spec: string) {
  const range = splitRange(spec)
  const repoRoot = yield* runGit(directory, ["rev-parse", "--show-toplevel"]).pipe(
    explainGit("not inside a git repository"),
    Effect.map(chompLine),
  )
  const headCommit = yield* resolveCommittish(repoRoot, range.head)
  const baseCommit = yield* mergeBaseOf(
    repoRoot,
    yield* resolveCommittish(repoRoot, range.base),
    headCommit,
  )
  const [diff, changedFiles, submodules, uncommitted] = yield* Effect.all(
    [
      runGit(repoRoot, ["diff", baseCommit, headCommit]).pipe(
        explainGit(`could not diff ${spec}`),
      ),
      runGit(repoRoot, [
        "diff",
        "--name-only",
        "--no-renames",
        "-z",
        baseCommit,
        headCommit,
      ]).pipe(
        explainGit(`could not list changed files for ${spec}`),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
      runGit(repoRoot, ["ls-tree", "-r", "-z", headCommit]).pipe(
        explainGit(`could not list the tree of ${spec}`),
        Effect.map(gitlinkPaths),
      ),
      // Tracked edits and untracked files alike are outside a committed
      // range; --no-renames keeps each entry one path so they can be counted.
      runGit(repoRoot, ["status", "--porcelain", "--no-renames", "-z"]).pipe(
        explainGit("could not inspect the working tree"),
        Effect.map((out) => out.split("\0").filter((line) => line !== "")),
      ),
    ],
    { concurrency: 2 },
  )

  if (diff === "") {
    return yield* new TargetUnresolvable({
      reason: `${spec} has no changes to review`,
      cause: undefined,
    })
  }

  return ReviewTarget.cases.Commits.make({
    repoRoot,
    baseCommit,
    headCommit,
    changedFiles,
    diff,
    warnings: [
      ...(uncommitted.length === 0 ? [] : [
        `${uncommitted.length} uncommitted file(s) not part of this review`,
      ]),
      ...submoduleWarning(submodules),
    ],
  })
})
