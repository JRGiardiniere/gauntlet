import * as Schema from "effect/Schema"

// The exact change under review, carrying its frozen diff and any
// scope-degradation warnings acquired with it (CONTEXT.md). The diff is
// stored exactly once — here, inside the frozen plan (ADR 0006).

export const ReviewTarget = Schema.TaggedUnion({
  WorkingTree: {
    repoRoot: Schema.String,
    // The HEAD commit the uncommitted changes are diffed against, and the
    // commit the persisted workspace overlay is relative to.
    headCommit: Schema.String,
    // Present only for the combined `--commits <base> --working-tree` form:
    // the merge-base the review diff starts from. Omission means the review
    // diff starts at headCommit — the uncommitted work alone.
    baseCommit: Schema.optionalKey(Schema.String),
    changedFiles: Schema.Array(Schema.NonEmptyString),
    diff: Schema.String,
    // Included non-ignored untracked files (≤10MB). Oversized and ignored
    // paths are omitted here and named only in warnings, if at all.
    untrackedFiles: Schema.Array(Schema.NonEmptyString),
    warnings: Schema.Array(Schema.String),
  },
  Commits: {
    repoRoot: Schema.String,
    // The resolved SHA pair is the whole frozen identity of a commit range:
    // the symbolic expressions the caller submitted are discarded here.
    baseCommit: Schema.String,
    headCommit: Schema.String,
    changedFiles: Schema.Array(Schema.NonEmptyString),
    diff: Schema.String,
    warnings: Schema.Array(Schema.String),
  },
  PullRequest: {
    repoRoot: Schema.String,
    number: Schema.Int,
    // A PR target means its head commit by definition (#15).
    headCommit: Schema.String,
    baseCommit: Schema.String,
    changedFiles: Schema.Array(Schema.NonEmptyString),
    diff: Schema.String,
    warnings: Schema.Array(Schema.String),
  },
})
export type ReviewTarget = typeof ReviewTarget.Type

// Target identity without the diff — what the Dossier carries (CONTEXT.md:
// the Dossier records target identity; the diff lives only in the plan).
export const TargetIdentity = Schema.TaggedUnion({
  WorkingTree: {
    repoRoot: Schema.String,
    headCommit: Schema.String,
    baseCommit: Schema.optionalKey(Schema.String),
  },
  Commits: {
    repoRoot: Schema.String,
    baseCommit: Schema.String,
    headCommit: Schema.String,
  },
  PullRequest: {
    repoRoot: Schema.String,
    number: Schema.Int,
    headCommit: Schema.String,
    baseCommit: Schema.String,
  },
})
export type TargetIdentity = typeof TargetIdentity.Type

export const targetIdentityOf = (target: ReviewTarget): TargetIdentity =>
  ReviewTarget.match<TargetIdentity>(target, {
    WorkingTree: ({ baseCommit, headCommit, repoRoot }) =>
      TargetIdentity.cases.WorkingTree.make(
        baseCommit === undefined
          ? { repoRoot, headCommit }
          : { repoRoot, headCommit, baseCommit },
      ),
    Commits: ({ baseCommit, headCommit, repoRoot }) =>
      TargetIdentity.cases.Commits.make({ repoRoot, baseCommit, headCommit }),
    PullRequest: ({ baseCommit, headCommit, number, repoRoot }) =>
      TargetIdentity.cases.PullRequest.make({
        repoRoot,
        number,
        headCommit,
        baseCommit,
      }),
  })
