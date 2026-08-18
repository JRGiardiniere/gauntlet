// GitHub's comment cap is 65536 characters; stay under it with the same
// 60k-byte budget the previous reviewer used. Oversize handling is a dumb
// cutoff: keep identity, truncate evidence, point at the run directory
// (ADR 0005).
export const SAFE_PR_COMMENT_BYTES = 60_000

export const FULL_DOSSIER_NOTE =
  "_Posted comment truncated to fit pull-request size; full Dossier in the run directory._"

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

const FINDINGS_HEADING = "\n## Findings"

export interface FittedComment {
  readonly body: string
  readonly truncated: boolean
}

const truncateToBytes = (text: string, budget: number): string => {
  if (budget <= 0) return ""
  if (utf8Bytes(text) <= budget) return text
  let end = Math.min(text.length, budget)
  while (end > 0 && utf8Bytes(text.slice(0, end)) > budget) {
    end -= 1
  }
  return text.slice(0, end)
}

// Split on the findings heading so evidence is cut first. If the prefix alone
// exceeds the budget, keep its leading identity and the truncation note.
export const fitPostedDossier = (markdown: string): FittedComment => {
  if (utf8Bytes(markdown) <= SAFE_PR_COMMENT_BYTES) {
    return { body: markdown, truncated: false }
  }
  const findingsAt = markdown.indexOf(FINDINGS_HEADING)
  const identity = findingsAt === -1 ? markdown : markdown.slice(0, findingsAt)
  const evidence = findingsAt === -1 ? "" : markdown.slice(findingsAt)
  const note = `\n\n${FULL_DOSSIER_NOTE}`
  const fittedIdentity = truncateToBytes(
    identity.trimEnd(),
    SAFE_PR_COMMENT_BYTES - utf8Bytes(note),
  )
  const prefix = `${fittedIdentity}${note}`
  const remaining = SAFE_PR_COMMENT_BYTES - utf8Bytes(prefix)
  const fittedEvidence = truncateToBytes(evidence, remaining)
  return {
    body: `${prefix}${fittedEvidence}`,
    truncated: true,
  }
}
