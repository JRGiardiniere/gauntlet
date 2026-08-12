import { Candidate } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import type { Severity } from "../domain/verdict.ts"
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

const location = (candidate: Candidate): string =>
  "line" in candidate && candidate.line !== undefined
    ? `${candidate.file}:${candidate.line}`
    : candidate.file

const findingLine = (
  candidate: Candidate,
  tier: Severity | undefined,
  tag: string | undefined,
  detail: string | undefined,
): string => {
  const tierLabel = tier === undefined ? "" : `**[${tier}]** `
  const tagLabel = tag === undefined ? "" : `\`[${tag}]\` `
  const detailLines = [
    ...(Candidate.guards.BugClaim(candidate)
      ? [`Failure scenario: ${candidate.failureScenario}`]
      : []),
    ...(detail === undefined ? [] : [detail]),
  ].map((line) => `\n  - ${line}`).join("")
  return `- ${tierLabel}${tagLabel}${location(candidate)} — ${candidate.summary} _(${candidate.lens})_${detailLines}`
}

const severityOrder: ReadonlyArray<Severity> = ["P1", "P2", "P3"]

// Findings by tier: confirmed/kept first within their tier, then
// unverified/undecided tagged in the main section — first-class, never
// banished to an appendix (ADR 0006).
const renderFindings = (view: DossierView): string => {
  const lines: Array<string> = []
  for (const tier of severityOrder) {
    for (const entry of view.confirmed) {
      if (entry.verdict.severity === tier) {
        lines.push(findingLine(entry.candidate, tier, undefined, entry.verdict.evidence))
      }
    }
    for (const entry of view.kept) {
      if (entry.judgment.tier === tier) {
        lines.push(findingLine(entry.candidate, tier, undefined, entry.judgment.reason))
      }
    }
    for (const entry of view.unverified) {
      if (entry.verdict.severity === tier) {
        lines.push(findingLine(entry.candidate, tier, "unverified", entry.verdict.evidence))
      }
    }
  }
  for (const entry of view.unverified) {
    if (entry.verdict.severity === undefined) {
      lines.push(findingLine(entry.candidate, undefined, "unverified", entry.verdict.evidence))
    }
  }
  for (const candidate of view.undecided) {
    lines.push(findingLine(candidate, undefined, "undecided", undefined))
  }
  return lines.length === 0 ? "No findings." : lines.join("\n")
}

const renderAppendix = (lines: ReadonlyArray<string>): string =>
  lines.length === 0 ? "None." : lines.join("\n")

// Rendered from the Dossier alone plus the frozen plan's header facts —
// deterministic presentation, no model calls (ADR 0006).
export const renderReport = (
  plan: ReviewPlan,
  dossier: Dossier,
  accounting: RunAccounting,
): string => {
  const view = viewDossier(dossier)
  const lensList = plan.lenses.length === 0
    ? "none"
    : plan.lenses
      .map((lens) => `${lens.name}@${lens.contentHash} (${lens.seat})`)
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

  const refutedLines = view.refuted.map((entry) =>
    findingLine(entry.candidate, undefined, "refuted", entry.verdict.evidence)
  )
  const droppedLines = view.dropped.map((entry) =>
    findingLine(entry.candidate, undefined, "dropped", entry.judgment.reason)
  )

  return [
    `# Gauntlet review ${dossier.runId}`,
    "",
    `- Target: ${describeTargetIdentity(dossier.target)}`,
    `- Recipe: ${recipeLine}`,
    `- Lenses: ${lensList}`,
    `- Cost: $${accounting.costUsd.toFixed(2)} · ${accounting.invocationCount} invocations · ${accounting.wallTimeSeconds}s`,
    `- Coverage gaps: ${coverageGaps}`,
    `- Warnings: ${warnings}`,
    "",
    "## Findings",
    "",
    renderFindings(view),
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
