import {
  ReviewSpecification,
  type SpecificationDocument,
} from "../domain/review-specification.ts"

const nonEmptyDocuments = (
  first: SpecificationDocument,
  rest: ReadonlyArray<SpecificationDocument>,
): typeof ReviewSpecification.Type.documents => [first, ...rest]

// Fetched source material is the authority. The Caller Addendum is appended
// after it, labeled by its document role, and never replaces or reorders it.
export const combineReviewSpecifications = (
  fetched: ReviewSpecification | undefined,
  addendum: ReviewSpecification | undefined,
): ReviewSpecification | undefined => {
  if (fetched === undefined) return addendum
  if (addendum === undefined) return fetched
  const [first, ...rest] = fetched.documents
  if (first === undefined) return addendum
  const documents = nonEmptyDocuments(first, [...rest, ...addendum.documents])
  return fetched.commentOmission === undefined
    ? ReviewSpecification.make({
        documents,
        comments: fetched.comments,
      })
    : ReviewSpecification.make({
        documents,
        comments: fetched.comments,
        commentOmission: fetched.commentOmission,
      })
}
