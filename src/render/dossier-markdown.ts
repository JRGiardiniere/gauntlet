import * as Array from "effect/Array"
import { pipe } from "effect/Function"
import * as Record from "effect/Record"
import { Candidate } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import { selectRunnableFinders } from "../domain/finder-selection.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import {
  describeFinderCacheHealth,
} from "../run/finder-cache-health.ts"
import { describeFinderToolHealth } from "../run/finder-tool-health.ts"
import type { RunAccounting } from "../run/run-accounting.ts"
import { formatCommentOmission } from "../specification/comment-budget.ts"
import {
  type DossierEntryView,
  viewDossier,
} from "./dossier-view.ts"
import { describeTargetIdentity } from "./target-text.ts"

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
  lenses.length > 1 ? `found by: ${Array.join(lenses, ", ")}` : Array.join(lenses, ", ")

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
    : `\n  - suggested tests: ${pipe(entry.testSuggestion.tests, Array.map(oneLine), Array.join(", "))} — ${oneLine(entry.testSuggestion.reason)}`
  return `- ${priorityLabel}\`[${entry.tag}]\` ${location(entry.candidate)} — ${oneLine(entry.candidate.summary)} _(${attribution(entry.lenses)})_${detailLine}${suggestionLine}`
}

const renderEntries = (
  entries: ReadonlyArray<DossierEntryView>,
  empty: string,
): string => entries.length === 0 ? empty : pipe(entries, Array.map(findingLine), Array.join("\n"))

export const describeRecipe = (plan: ReviewPlan): string => {
  const seatList = pipe(
    Record.toEntries<string, string | undefined>(plan.seats),
    Array.map(([stage, seat]) => `${stage}: ${seat}`),
    Array.join(", "),
  )
  return plan.recipeName === undefined
    ? seatList === ""
      ? "none — no seats resolved"
      : `none (${seatList})`
    : `${plan.recipeName} (${seatList})`
}

export const describeRunNotes = (
  accounting: RunAccounting,
): ReadonlyArray<string> => [
  ...(accounting.finderCacheHealth === undefined ? [] : [
    `Finder cache ${describeFinderCacheHealth(accounting.finderCacheHealth)}.`,
  ]),
  ...(accounting.finderToolHealth === undefined ? [] : [
    `Finder tools: ${describeFinderToolHealth(accounting.finderToolHealth)}.`,
  ]),
]

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
    : pipe(finderSelection.runnable, Array.map((lens) => `${lens.name} (${lens.seat})`), Array.join(", "))
  const coverageGaps = dossier.coverageGaps.length === 0
    ? "none"
    : pipe(
      dossier.coverageGaps,
      Array.map((gap) => `${gap.stage}${gap.lens === undefined ? "" : ` (${gap.lens})`}: ${gap.reason}`),
      Array.join("; "),
    )
  // Scope-degradation warnings (e.g. untracked files outside the diff) must
  // reach the reader — a review that silently narrowed its scope would
  // otherwise present as complete.
  const warnings = plan.target.warnings.length === 0
    ? "none"
    : Array.join(plan.target.warnings, "; ")
  const commentBudget = plan.specification?.commentOmission === undefined
    ? undefined
    : formatCommentOmission(plan.specification.commentOmission)

  const headerFacts = [
    `- Target: ${describeTargetIdentity(dossier.target)}`,
    `- Recipe: ${describeRecipe(plan)}`,
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
      `- Skipped: ${
        pipe(finderSelection.skipped, Array.map(({ lens, reason }) => `${lens.name} — ${reason}`), Array.join("; "))
      }`,
    )
  }

  const runNotes = describeRunNotes(accounting)
  const runNotesSection = runNotes.length === 0
    ? []
    : ["", "## Run notes", "", ...Array.map(runNotes, (note) => `- ${note}`)]

  return Array.join([
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
  ], "\n")
}
