import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"

// The exact change under review, carrying its frozen diff and any
// scope-degradation warnings acquired with it (CONTEXT.md). The diff is
// stored exactly once — here, inside the frozen plan (ADR 0006).

// Content identity of one included untracked file. Digests are hashes, never
// file bytes — resume compares these, and the run directory must not store
// snapshot contents.
export const UntrackedFileDigest = Schema.Struct({
  path: Schema.NonEmptyString,
  digest: Schema.NonEmptyString,
})
export type UntrackedFileDigest = typeof UntrackedFileDigest.Type

export const ReviewTarget = Schema.TaggedUnion({
  WorkingTree: {
    repoRoot: Schema.String,
    // The HEAD commit the uncommitted changes are diffed against.
    headCommit: Schema.String,
    changedFiles: Schema.Array(Schema.NonEmptyString),
    diff: Schema.String,
    // Included non-ignored untracked files (≤10MB), hashed at freeze so
    // content drift is visible to the resume identity check. Oversized and
    // ignored paths are omitted here and named only in warnings, if at all.
    // Missing on plans frozen before this field existed; decode as empty so
    // those runs still load.
    untrackedFiles: Schema.Array(UntrackedFileDigest).pipe(
      Schema.withDecodingDefaultKey(Effect.succeed([])),
    ),
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
