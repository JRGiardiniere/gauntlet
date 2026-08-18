import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import {
  ReviewSpecification,
  SpecificationSourceDiagnostic,
  type SpecificationComment,
  type SpecificationDocument,
} from "../domain/review-specification.ts"
import {
  Linear,
  type LinearBranchIssue,
  type LinearError,
  type LinearIssueSnapshot,
} from "../linear/linear.ts"
import { trimCommentBudget } from "./comment-budget.ts"

type LinearSpecificationResolution = Data.TaggedEnum<{
  Absent: {}
  Resolved: { readonly specification: ReviewSpecification }
  Unreachable: { readonly diagnostic: SpecificationSourceDiagnostic }
}>

export const LinearSpecificationResolution =
  Data.taggedEnum<LinearSpecificationResolution>()

const ISSUE_IDENTIFIER = /(?:^|[^A-Za-z0-9])([A-Za-z][A-Za-z0-9]*-\d+)(?=$|[^A-Za-z0-9])/g
const GENERIC_BRANCH_KEYS = new Set(["ISSUE", "PR", "SLICE"])

// Linear links a branch by the issue identifier contained in its name. The
// current branch is the entire discovery surface: no title, body, comment, or
// remote metadata is accepted as a fallback signal.
export const linearIssueIdentifierFromBranch = (
  branch: string,
): string | undefined => {
  const identifiers = new Set(
    [...branch.matchAll(ISSUE_IDENTIFIER)].flatMap((match) =>
      match[1] === undefined
        ? []
        : GENERIC_BRANCH_KEYS.has(match[1].slice(0, match[1].lastIndexOf("-")).toUpperCase())
          ? []
          : [match[1].toUpperCase()]
    ),
  )
  return identifiers.size === 1 ? [...identifiers][0] : undefined
}

const document = (
  role: "parent" | "sibling" | "slice",
  issue: LinearIssueSnapshot,
): SpecificationDocument => ({
  role,
  provenance: issue.url,
  text: role === "sibling" ? "" : issue.body,
  title: issue.title,
  state: issue.state,
})

const comments = (
  issue: LinearIssueSnapshot,
): ReadonlyArray<SpecificationComment> =>
  issue.comments.flatMap((comment) =>
    comment.isBot
      ? []
      : [{
          provenance: comment.url,
          createdAt: comment.createdAt,
          text: comment.body,
        }]
  )

export const reviewSpecificationFromLinearIssue = (
  issue: LinearBranchIssue,
): ReviewSpecification => {
  const siblingDocuments = [...issue.siblings]
    .sort((left, right) => left.identifier.localeCompare(right.identifier))
    .map((sibling) => document("sibling", sibling))
  const documents: readonly [
    SpecificationDocument,
    ...Array<SpecificationDocument>,
  ] = issue.parent === undefined
    ? [document("slice", issue), ...siblingDocuments]
    : [document("parent", issue.parent), document("slice", issue), ...siblingDocuments]
  const trimmed = trimCommentBudget([
    ...(issue.parent === undefined ? [] : comments(issue.parent)),
    ...comments(issue),
  ])
  return trimmed.commentOmission === undefined
    ? ReviewSpecification.make({
        documents,
        comments: trimmed.comments,
      })
    : ReviewSpecification.make({
        documents,
        comments: trimmed.comments,
        commentOmission: trimmed.commentOmission,
      })
}

const diagnosticMessage = (
  branch: string,
  identifier: string,
  error: LinearError,
): string => {
  const prefix = `Linear issue ${identifier} was detected from branch ${branch}, but`
  switch (error.reason) {
    case "missing-api-key":
      return `${prefix} LINEAR_API_KEY is not set. Set it and rerun the review.`
    case "invalid-api-key":
      return `${prefix} Linear rejected LINEAR_API_KEY. Replace the key and rerun the review.`
    case "unresolvable-issue":
      return `${prefix} the issue could not be resolved. Check the branch issue ID and API-key workspace access.`
    case "invalid-response":
      return `${prefix} Linear returned an invalid response. Retry, then check the Linear API if it persists.`
    case "unreachable":
      return `${prefix} Linear could not be reached. Check connectivity and rerun the review.`
  }
}

export const loadLinearSpecification = Effect.fn(
  "gauntlet.specification.load_linear",
)(function* (branch: string) {
  const identifier = linearIssueIdentifierFromBranch(branch)
  if (identifier === undefined) {
    return LinearSpecificationResolution.Absent()
  }
  const linear = yield* Linear
  return yield* linear.viewIssue(identifier).pipe(
    Effect.map((issue) =>
      LinearSpecificationResolution.Resolved({
        specification: reviewSpecificationFromLinearIssue(issue),
      })
    ),
    Effect.catchTag("LinearError", (error) =>
      Effect.succeed(
        LinearSpecificationResolution.Unreachable({
          diagnostic: SpecificationSourceDiagnostic.make({
            source: "Linear",
            branch,
            issueIdentifier: identifier,
            reason: error.reason,
            message: diagnosticMessage(branch, identifier, error),
          }),
        }),
      )
    ),
  )
})
