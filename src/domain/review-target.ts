import * as Schema from "effect/Schema"

// The exact change under review, carrying its frozen diff and any
// scope-degradation warnings acquired with it (CONTEXT.md). The diff is
// stored exactly once — here, inside the frozen plan (ADR 0006).
export const ReviewTarget = Schema.TaggedUnion({
  WorkingTree: {
    repoRoot: Schema.String,
    // The HEAD commit the uncommitted changes are diffed against.
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
    WorkingTree: ({ headCommit, repoRoot }) =>
      TargetIdentity.cases.WorkingTree.make({ repoRoot, headCommit }),
    PullRequest: ({ baseCommit, headCommit, number, repoRoot }) =>
      TargetIdentity.cases.PullRequest.make({
        repoRoot,
        number,
        headCommit,
        baseCommit,
      }),
  })
