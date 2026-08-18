import type {
  ReviewSpecification,
  SpecificationDocument,
} from "../domain/review-specification.ts"
import { formatCommentOmission } from "../specification/comment-budget.ts"

const issueHeading = (
  kind: string,
  document: SpecificationDocument,
): string => {
  const title = document.title === undefined || document.title.trim() === ""
    ? ""
    : ` ${document.title}`
  const state = document.state === undefined ? "" : ` [${document.state}]`
  return `### ${kind}:${title} (${document.provenance})${state}`
}

const documentHeading = (document: SpecificationDocument): string => {
  switch (document.role) {
    case "caller-addendum":
      return `### Caller Addendum (caller-provided: ${document.provenance})`
    case "parent":
      return issueHeading("Parent", document)
    case "slice":
      return issueHeading("Current Slice", document)
  }
}

const documentBlocks = (document: SpecificationDocument): ReadonlyArray<string> => {
  const heading = documentHeading(document)
  const text = document.text.trim()
  return text === "" ? [heading] : [heading, text]
}

const commentBlocks = (
  specification: ReviewSpecification,
): ReadonlyArray<string> => {
  const blocks: Array<string> = []
  if (specification.commentOmission !== undefined) {
    blocks.push("### Comment budget", formatCommentOmission(specification.commentOmission))
  }
  if (specification.comments.length === 0) return blocks
  blocks.push("### Admitted comments")
  for (const comment of specification.comments) {
    const text = comment.text.trim()
    const heading = `#### Comment (${comment.provenance}) at ${comment.createdAt}`
    if (text === "") {
      blocks.push(heading)
    } else {
      blocks.push(heading, text)
    }
  }
  return blocks
}

// Rendered only when a ReviewSpecification exists — a run without one carries
// no absence text in any prompt (issue #73). The section sits after the
// shared/stable context and before the invocation-specific assignment.
export const renderSpecificationSection = (
  specification: ReviewSpecification,
): string =>
  [
    "## Review Specification",
    "The requirement material behind this change — what the author was asked to deliver. Use it to judge intent and scope; the current obligations it states define what is owed now. Fetched source text is the authority; a Caller Addendum is additional caller-provided context.",
    ...specification.documents.flatMap(documentBlocks),
    ...commentBlocks(specification),
  ].join("\n\n")
