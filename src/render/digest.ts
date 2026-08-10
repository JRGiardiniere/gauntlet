import type { Dossier } from "../domain/dossier.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import { viewDossier } from "./dossier-view.ts"
import type { RunPaths } from "../run/run-record.ts"

const shortCommit = (commit: string) => commit.slice(0, 7)

const describeTargetShort = (target: TargetIdentity): string =>
  TargetIdentity.match(target, {
    WorkingTree: ({ headCommit }) => `working tree @ ${shortCommit(headCommit)}`,
    PullRequest: ({ number }) => `PR #${number}`,
  })

// The bounded stdout digest (ADR 0005): one tally line, one line per
// surviving finding (confirmed BugClaims and kept Observations), then
// artifact paths. Refuted, dropped, and evidence live only in the run dir —
// machine consumers parse dossier.json from disk, never stdout.
export const renderDigest = (
  plan: ReviewPlan,
  dossier: Dossier,
  paths: RunPaths,
): string => {
  const view = viewDossier(dossier)
  const recipeName = plan.recipeName ?? "none"
  const tally =
    `${view.confirmed.length} confirmed · ${view.kept.length} kept · ` +
    `${view.unverified.length} unverified · ${view.undecided.length} undecided — ` +
    `${describeTargetShort(dossier.target)} — recipe: ${recipeName}`
  const surviving = [
    ...view.confirmed.map((entry) => {
      const line = entry.candidate.line === undefined ? "" : `:${entry.candidate.line}`
      return `- [${entry.verdict.severity}] ${entry.candidate.file}${line} — ${entry.candidate.summary}`
    }),
    ...view.kept.map((entry) => {
      const line = entry.candidate.line === undefined ? "" : `:${entry.candidate.line}`
      return `- [${entry.judgment.tier}] ${entry.candidate.file}${line} — ${entry.candidate.summary}`
    }),
  ]
  return [
    tally,
    ...surviving,
    "",
    `report: ${paths.report}`,
    `dossier: ${paths.dossier}`,
  ].join("\n")
}
