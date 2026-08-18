import { Candidate } from "../domain/candidate.ts"
import type { Dossier, TestSuggestion } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import type { ReviewPriority } from "../domain/verdict.ts"
import { formatCommentOmission } from "../specification/comment-budget.ts"
import { type DossierView, viewDossier } from "./dossier-view.ts"

export interface RunAccounting {
  readonly costUsd: number
  readonly invocationCount: number
  readonly wallTimeSeconds: number
}

const shortCommit = (commit: string) => commit.slice(0, 7)

export const describeTargetIdentity = (target: TargetIdentity): string =>
  TargetIdentity.match(target, {
    WorkingTree: ({ headCommit, repoRoot }) =>
      `working tree at ${repoRoot} (HEAD ${shortCommit(headCommit)})`,
    PullRequest: ({ headCommit, number }) =>
      `PR #${number} (head ${shortCommit(headCommit)})`,
  })

// File paths, summaries, reasons, evidence, and failure scenarios are
// model-authored. One finding must stay one list item, so line breaks
// flatten to spaces — the verbatim text lives in dossier.json.
const oneLine = (text: string): string => text.replace(/\s+/g, " ").trim()

const location = (candidate: Candidate): string =>
  oneLine(
    "line" in candidate && candidate.line !== undefined
      ? `${candidate.file}:${candidate.line}`
      : candidate.file,
  )

// Cluster-mates render as one finding, so a finding can carry several lenses.
const attribution = (lenses: ReadonlyArray<string>): string =>
  lenses.length > 1 ? `found by: ${lenses.join(", ")}` : lenses.join(", ")

// One explanation per finding: the evaluated framing when a verdict or judgment
// supplied one, otherwise the claim's own failure scenario. Both would restate
// the same thing; the verbatim pair lives in dossier.json.
const explanation = (
  candidate: Candidate,
  detail: string | undefined,
): string | undefined =>
  detail ??
    (Candidate.guards.BugClaim(candidate) ? candidate.failureScenario : undefined)

const findingLine = (
  candidate: Candidate,
  lenses: ReadonlyArray<string>,
  priority: ReviewPriority | undefined,
  tag: string | undefined,
  detail: string | undefined,
  suggestion?: TestSuggestion,
): string => {
  const priorityLabel = priority === undefined ? "" : `**[${priority}]** `
  const tagLabel = tag === undefined ? "" : `\`[${tag}]\` `
  const explained = explanation(candidate, detail)
  const detailLine = explained === undefined ? "" : `\n  - ${oneLine(explained)}`
  // A TestSuggestion stays next to the claim it serves, so the reason for
  // running a test remains visible with the finding's context.
  const suggestionLine = suggestion === undefined
    ? ""
    : `\n  - suggested tests: ${suggestion.tests.map(oneLine).join(", ")} — ${oneLine(suggestion.reason)}`
  return `- ${priorityLabel}${tagLabel}${location(candidate)} — ${oneLine(candidate.summary)} _(${attribution(lenses)})_${detailLine}${suggestionLine}`
}

const reviewPriorityOrder: ReadonlyArray<ReviewPriority> = ["P1", "P2", "P3"]

// Every cluster-mate's stable id maps to its cluster's suggestion, so the
// lookup works from whichever mate presentation chose to render.
const suggestionByClaimId = (
  suggestions: Dossier["testSuggestions"],
): ReadonlyMap<string, TestSuggestion> =>
  new Map(
    suggestions.flatMap((suggestion) =>
      suggestion.bugClaimIds.map((id) => [id, suggestion] as const)
    ),
  )

// Findings by Review Priority: confirmed/kept first within their priority, then
// unverified/undecided tagged in the main section — first-class, never
// banished to an appendix (ADR 0006).
const renderFindings = (
  view: DossierView,
  suggestionFor: ReadonlyMap<string, TestSuggestion>,
): string => {
  const lines: Array<string> = []
  for (const priority of reviewPriorityOrder) {
    for (const entry of view.confirmed) {
      if (entry.verdict.reviewPriority === priority) {
        lines.push(
          findingLine(
            entry.candidate,
            entry.lenses,
            priority,
            undefined,
            entry.verdict.evidence,
            suggestionFor.get(entry.candidate.id),
          ),
        )
      }
    }
    for (const entry of view.kept) {
      if (entry.judgment.reviewPriority === priority) {
        lines.push(
          findingLine(
            entry.candidate,
            [entry.candidate.lens],
            priority,
            undefined,
            entry.judgment.reason,
          ),
        )
      }
    }
    for (const entry of view.unverified) {
      if (entry.verdict.reviewPriority === priority) {
        lines.push(
          findingLine(
            entry.candidate,
            entry.lenses,
            priority,
            "unverified",
            entry.verdict.evidence,
            suggestionFor.get(entry.candidate.id),
          ),
        )
      }
    }
  }
  for (const entry of view.unverified) {
    if (entry.verdict.reviewPriority === undefined) {
      lines.push(
        findingLine(
          entry.candidate,
          entry.lenses,
          undefined,
          "unverified",
          entry.verdict.evidence,
          suggestionFor.get(entry.candidate.id),
        ),
      )
    }
  }
  for (const candidate of view.undecided) {
    lines.push(findingLine(candidate, [candidate.lens], undefined, "undecided", undefined))
  }
  return lines.length === 0 ? "No findings." : lines.join("\n")
}

const renderAppendix = (lines: ReadonlyArray<string>): string =>
  lines.length === 0 ? "None." : lines.join("\n")

// Rendered from the Dossier alone plus the frozen plan's header facts —
// deterministic presentation, no model calls (ADR 0006).
export const renderDossierMarkdown = (
  plan: ReviewPlan,
  dossier: Dossier,
  accounting: RunAccounting,
): string => {
  const view = viewDossier(dossier)
  const lensList = plan.lenses.length === 0
    ? "none"
    : plan.lenses
      .map((lens) => `${lens.name} (${lens.seat})`)
      .join(", ")
  const seatList = Object.entries(plan.seats)
    .map(([stage, seat]) => `${stage}: ${seat}`)
    .join(", ")
  const recipeLine = plan.recipeName === undefined
    ? seatList === ""
      ? "none — no seats resolved"
      : `none (${seatList})`
    : `${plan.recipeName} (${seatList})`
  const coverageGaps = dossier.coverageGaps.length === 0
    ? "none"
    : dossier.coverageGaps
      .map((gap) => `${gap.stage}${gap.lens === undefined ? "" : ` (${gap.lens})`}: ${gap.reason}`)
      .join("; ")
  // Scope-degradation warnings (e.g. untracked files outside the diff) must
  // reach the reader — a review that silently narrowed its scope would
  // otherwise present as complete.
  const warnings = plan.target.warnings.length === 0
    ? "none"
    : plan.target.warnings.join("; ")
  const commentBudget = plan.specification?.commentOmission === undefined
    ? undefined
    : formatCommentOmission(plan.specification.commentOmission)

  const headerFacts = [
    `- Target: ${describeTargetIdentity(dossier.target)}`,
    `- Recipe: ${recipeLine}`,
    `- Lenses: ${lensList}`,
    `- Cost: $${accounting.costUsd.toFixed(2)} · ${accounting.invocationCount} invocations · ${accounting.wallTimeSeconds}s`,
    `- Coverage gaps: ${coverageGaps}`,
    `- Warnings: ${warnings}`,
  ]
  if (commentBudget !== undefined) {
    headerFacts.push(`- Comment budget: ${commentBudget}`)
  }

  const refutedLines = view.refuted.map((entry) =>
    findingLine(entry.candidate, entry.lenses, undefined, "refuted", entry.verdict.evidence)
  )
  const droppedLines = view.dropped.map((entry) =>
    findingLine(
      entry.candidate,
      [entry.candidate.lens],
      undefined,
      "dropped",
      entry.judgment.reason,
    )
  )

  return [
    `# Gauntlet review ${dossier.runId}`,
    "",
    ...headerFacts,
    "",
    "## Findings",
    "",
    renderFindings(view, suggestionByClaimId(dossier.testSuggestions)),
    "",
    "## Appendix: refuted claims",
    "",
    renderAppendix(refutedLines),
    "",
    "## Appendix: dropped observations",
    "",
    renderAppendix(droppedLines),
    "",
  ].join("\n")
}
