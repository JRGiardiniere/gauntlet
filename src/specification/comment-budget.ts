import type {
  CommentOmission,
  SpecificationComment,
} from "../domain/review-specification.ts"

export const COMMENT_BUDGET_CHARACTERS = 20_000

const byChronology = (
  left: SpecificationComment,
  right: SpecificationComment,
): number =>
  left.createdAt < right.createdAt
    ? -1
    : left.createdAt > right.createdAt
      ? 1
      : left.provenance.localeCompare(right.provenance)

export const formatCommentOmission = (omission: CommentOmission): string =>
  `Dropped ${String(omission.droppedCount)} earliest comments (${String(omission.droppedCharacters)} characters). Cutoff: ${omission.cutoff}.`

export interface TrimmedComments {
  readonly comments: ReadonlyArray<SpecificationComment>
  readonly commentOmission: CommentOmission | undefined
}

// Earliest-first whole-comment trim across every admitted thread. Never
// splits a comment; the caller never passes issue bodies in.
export const trimCommentBudget = (
  comments: ReadonlyArray<SpecificationComment>,
): TrimmedComments => {
  const ordered = [...comments].sort(byChronology)
  let total = ordered.reduce((sum, comment) => sum + comment.text.length, 0)
  if (total <= COMMENT_BUDGET_CHARACTERS) {
    return { comments: ordered, commentOmission: undefined }
  }

  const retained = [...ordered]
  let droppedCount = 0
  let droppedCharacters = 0
  while (retained.length > 0 && total > COMMENT_BUDGET_CHARACTERS) {
    const earliest = retained.shift()
    if (earliest === undefined) break
    droppedCount += 1
    droppedCharacters += earliest.text.length
    total -= earliest.text.length
  }

  const cutoff = retained[0]?.createdAt ?? ordered[ordered.length - 1]?.createdAt
  return {
    comments: retained,
    commentOmission: {
      droppedCount,
      droppedCharacters,
      cutoff: cutoff ?? "none",
    },
  }
}
