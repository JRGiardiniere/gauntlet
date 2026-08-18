import * as Effect from "effect/Effect"
import {
  ReviewSpecification,
  type SpecificationComment,
  type SpecificationDocument,
} from "../domain/review-specification.ts"
import { GitHub, type GitHubClosingIssue, type GitHubIssueSnapshot } from "../github/github.ts"
import { trimCommentBudget } from "./comment-budget.ts"

const ADMITTED_ASSOCIATIONS = new Set(["OWNER", "MEMBER", "COLLABORATOR"])

const byIssueIdentity = (
  left: GitHubIssueSnapshot,
  right: GitHubIssueSnapshot,
): number =>
  left.number - right.number || left.url.localeCompare(right.url)

const issueDocument = (
  role: "parent" | "slice",
  issue: GitHubIssueSnapshot,
): SpecificationDocument => ({
  role,
  provenance: issue.url,
  text: issue.body,
  title: issue.title,
  state: issue.state,
})

const admittedComments = (
  issue: GitHubIssueSnapshot,
): ReadonlyArray<SpecificationComment> =>
  issue.comments
    .filter((comment) => ADMITTED_ASSOCIATIONS.has(comment.authorAssociation))
    .map((comment) => ({
      provenance: comment.url,
      createdAt: comment.createdAt,
      text: comment.body,
    }))

// Assemble a source-neutral ReviewSpecification from GitHub closing issues.
// Native parent only — issue bodies are never parsed for `## Parent`.
export const reviewSpecificationFromGitHubIssues = (
  issues: ReadonlyArray<GitHubClosingIssue>,
): ReviewSpecification | undefined => {
  if (issues.length === 0) return undefined

  const slices = [...issues].sort(byIssueIdentity)
  const sliceUrls = new Set(slices.map((slice) => slice.url))
  const parentsByUrl = new Map<string, GitHubIssueSnapshot>()
  for (const slice of slices) {
    if (slice.parent !== undefined && !sliceUrls.has(slice.parent.url)) {
      parentsByUrl.set(slice.parent.url, slice.parent)
    }
  }
  const parents = [...parentsByUrl.values()].sort(byIssueIdentity)
  const documents = [
    ...parents.map((parent) => issueDocument("parent", parent)),
    ...slices.map((slice) => issueDocument("slice", slice)),
  ]
  const [first, ...rest] = documents
  if (first === undefined) return undefined

  const uniqueIssues = new Map<string, GitHubIssueSnapshot>()
  for (const parent of parents) uniqueIssues.set(parent.url, parent)
  for (const slice of slices) uniqueIssues.set(slice.url, slice)

  const trimmed = trimCommentBudget(
    [...uniqueIssues.values()].flatMap(admittedComments),
  )
  return trimmed.commentOmission === undefined
    ? ReviewSpecification.make({
        documents: [first, ...rest],
        comments: trimmed.comments,
      })
    : ReviewSpecification.make({
        documents: [first, ...rest],
        comments: trimmed.comments,
        commentOmission: trimmed.commentOmission,
      })
}

// GitHub unavailability is the quiet no-spec path (issue #74): the ordinary
// review proceeds; nothing announces that specification context was missing.
export const loadGitHubSpecification = Effect.fn(
  "gauntlet.specification.load_github",
)(function* (cwd: string, number: number) {
  const github = yield* GitHub
  const issues = yield* github.viewClosingIssues(cwd, number).pipe(
    Effect.catchTag("GitHubError", () =>
      Effect.succeed<ReadonlyArray<GitHubClosingIssue>>([])),
  )
  return reviewSpecificationFromGitHubIssues(issues)
})
