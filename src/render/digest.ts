import type { Dossier } from "../domain/dossier.ts"
import { selectRunnableFinders } from "../domain/finder-selection.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import {
  describeFinderToolHealth,
  isFinderToolCascade,
} from "../run/finder-tool-health.ts"
import type { RunAccounting } from "../run/run-accounting.ts"
import { viewDossier } from "./dossier-view.ts"
import type { RunPaths } from "../run/run-record.ts"

const shortCommit = (commit: string) => commit.slice(0, 7)

const describeTargetShort = (target: TargetIdentity): string =>
  TargetIdentity.match(target, {
    WorkingTree: ({ baseCommit, headCommit }) =>
      `working tree @ ${shortCommit(headCommit)}${
        baseCommit === undefined ? "" : ` since ${shortCommit(baseCommit)}`
      }`,
    Commits: ({ baseCommit, headCommit }) =>
      `commits ${shortCommit(baseCommit)}..${shortCommit(headCommit)}`,
    PullRequest: ({ number }) => `PR #${number}`,
  })

// Candidate text is model-authored: the digest's bounded, line-oriented
// contract (one finding = one line) survives only if that text can neither
// break lines nor balloon them. The full text stays in the run dir.
const boundedLine = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > 200 ? `${flat.slice(0, 199)}…` : flat
}

const candidateLocation = (candidate: {
  readonly file: string
  readonly line?: number
}): string =>
  boundedLine(
    `${candidate.file}${candidate.line === undefined ? "" : `:${candidate.line}`}`,
  )

// The bounded stdout digest (ADR 0005): one tally line (counts, target,
// recipe, wall time; cost stays in dossier.md — ADR 0006), one line per surviving finding
// plus one bounded line per candidate still carried in the main findings
// section, then artifact paths. Finder cache health stays in dossier.md: an
// agent relaying the digest called it out as if it were a finding (#138). Refuted, dropped, and evidence live only in
// the run dir — machine consumers parse dossier.json from disk, never stdout.
export const renderDigest = (
  plan: ReviewPlan,
  dossier: Dossier,
  accounting: RunAccounting,
  paths: RunPaths,
): string => {
  const view = viewDossier(dossier)
  const recipeName = plan.recipeName ?? "none"
  const confirmed = view.findings.filter(({ tag }) => tag === "confirmed")
    .length
  const kept = view.findings.filter(({ tag }) => tag === "judgment").length
  const plausible = view.unresolved.filter(({ tag }) => tag === "plausible")
    .length
  const undecided = view.unresolved.filter(({ tag }) => tag === "undecided")
    .length
  const tally =
    `${String(confirmed)} confirmed · ${String(kept)} kept · ` +
    `${String(plausible)} plausible · ${String(undecided)} undecided — ` +
    `${describeTargetShort(dossier.target)} — recipe: ${recipeName} — ` +
    `${accounting.wallTimeSeconds}s`
  const surviving = [...view.findings, ...view.unresolved].map((entry) => {
    const label = entry.reviewPriority === undefined
      ? entry.tag
      : `${entry.reviewPriority} ${entry.tag}`
    return `- [${label}] ${candidateLocation(entry.candidate)} — ${boundedLine(entry.candidate.summary)}`
  })
  // A review missing work must say so where the agent relays it: a run whose
  // every Finder failed otherwise reads as a clean zero (ADR 0005, #137).
  const coverageGaps = dossier.coverageGaps.length === 0
    ? undefined
    : boundedLine(
      `coverage gaps: ${String(dossier.coverageGaps.length)} — ${
        dossier.coverageGaps.map((gap) =>
          `${gap.lens ?? gap.stage} (${gap.reason})`
        ).join("; ")
      }`,
    )
  const toolHealth = accounting.finderToolHealth !== undefined &&
      isFinderToolCascade(accounting.finderToolHealth)
    ? boundedLine(
      `tool health: ${describeFinderToolHealth(accounting.finderToolHealth)}`,
    )
    : undefined
  // A lens that doesn't apply is skipped by design, not missing work, so it
  // is named apart from the coverage gaps: otherwise only dossier.md says it
  // never ran.
  const skipped = selectRunnableFinders(plan).skipped
  const notRun = skipped.length === 0
    ? undefined
    : `Not run: ${skipped.map(({ lens, reason }) => `${lens.name} (${reason})`).join(", ")}`
  return [
    tally,
    ...(coverageGaps === undefined ? [] : [coverageGaps]),
    ...(toolHealth === undefined ? [] : [toolHealth]),
    ...(notRun === undefined ? [] : [notRun]),
    ...surviving,
    "",
    `dossier.md: ${paths.dossierMarkdown}`,
    `dossier.json: ${paths.dossier}`,
  ].join("\n")
}
