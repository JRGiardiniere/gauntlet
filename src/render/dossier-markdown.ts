import { Candidate } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import { selectRunnableFinders } from "../domain/finder-selection.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import type { FinderCacheHealth } from "../run/finder-cache-health.ts"
import {
  describeFinderCacheHealth,
  lowFinderCacheHealth,
} from "../run/finder-cache-health.ts"
import { formatCommentOmission } from "../specification/comment-budget.ts"
import {
  type DossierEntryView,
  viewDossier,
} from "./dossier-view.ts"

export interface RunAccounting {
  readonly costUsd: number
  readonly invocationCount: number
  readonly wallTimeSeconds: number
  readonly finderCacheHealth: ReadonlyArray<FinderCacheHealth>
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

const findingLine = (entry: DossierEntryView): string => {
  const priorityLabel = entry.reviewPriority === undefined
    ? ""
    : `**[${entry.reviewPriority}]** `
  const explained = explanation(entry.candidate, entry.detail)
  const detailLine = explained === undefined ? "" : `\n  - ${oneLine(explained)}`
  // A TestSuggestion stays next to the claim it serves, so the reason for
  // running a test remains visible with the finding's context.
  const suggestionLine = entry.testSuggestion === undefined
    ? ""
    : `\n  - suggested tests: ${entry.testSuggestion.tests.map(oneLine).join(", ")} — ${oneLine(entry.testSuggestion.reason)}`
  return `- ${priorityLabel}\`[${entry.tag}]\` ${location(entry.candidate)} — ${oneLine(entry.candidate.summary)} _(${attribution(entry.lenses)})_${detailLine}${suggestionLine}`
}

const renderEntries = (
  entries: ReadonlyArray<DossierEntryView>,
  empty: string,
): string => entries.length === 0 ? empty : entries.map(findingLine).join("\n")

// Rendered from the Dossier alone plus the frozen plan's header facts —
// deterministic presentation, no model calls (ADR 0006).
export const renderDossierMarkdown = (
  plan: ReviewPlan,
  dossier: Dossier,
  accounting: RunAccounting,
): string => {
  const view = viewDossier(dossier)
  const finderSelection = selectRunnableFinders(plan)
  const lensList = finderSelection.runnable.length === 0
    ? "none"
    : finderSelection.runnable
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
  if (plan.specificationSourceDiagnostic !== undefined) {
    headerFacts.push(
      `- Specification source: ${plan.specificationSourceDiagnostic.message}`,
    )
  }
  if (finderSelection.skipped.length > 0) {
    headerFacts.push(
      `- Skipped: ${finderSelection.skipped.map(({ name }) => name).join(", ")} — no ReviewSpecification`,
    )
  }

  const runNotes = lowFinderCacheHealth(accounting.finderCacheHealth)
    .map((health) => `- Finder cache ${describeFinderCacheHealth(health)}.`)
  const runNotesSection = runNotes.length === 0
    ? []
    : ["", "## Run notes", "", ...runNotes]

  return [
    `# Gauntlet review ${dossier.runId}`,
    "",
    ...headerFacts,
    ...runNotesSection,
    "",
    "## Findings",
    "",
    renderEntries(view.findings, "No findings."),
    "",
    "## Unresolved",
    "",
    renderEntries(view.unresolved, "None."),
    "",
    "## Rejected",
    "",
    "### Refuted Claims",
    "",
    renderEntries(view.refutedClaims, "None."),
    "",
    "### Dropped Observations",
    "",
    renderEntries(view.droppedObservations, "None."),
    "",
  ].join("\n")
}
