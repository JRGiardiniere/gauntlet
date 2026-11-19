import * as Array from "effect/Array"
import { pipe } from "effect/Function"
import type { Dossier } from "../domain/dossier.ts"
import { selectRunnableFinders } from "../domain/finder-selection.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { SeatedStageName } from "../domain/stage.ts"
import {
  describeFinderToolHealth,
  isFinderToolCascade,
} from "../run/finder-tool-health.ts"
import {
  describeTokens,
  type RunAccounting,
  totalTokens,
} from "../run/run-accounting.ts"
import {
  type DossierEntryView,
  type DossierView,
  viewDossier,
} from "./dossier-view.ts"
import { describeTargetShort } from "./target-text.ts"

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

const entryLine = (entry: DossierEntryView): string =>
  `- [${entry.tag}] ${candidateLocation(entry.candidate)} — ${boundedLine(entry.candidate.summary)}`

// "2 confirmed, 1 judgment": the tags of entries the digest leaves to
// dossier.md, in their first-seen order.
const tagCounts = (entries: ReadonlyArray<DossierEntryView>): string =>
  pipe(
    Array.dedupe(Array.map(entries, ({ tag }) => tag)),
    Array.map((tag) =>
      `${String(Array.filter(entries, (entry) => entry.tag === tag).length)} ${tag}`
    ),
    Array.join(", "),
  )

// Findings then Unresolved, grouped by Review Priority: P1 and P2 entries in
// full, P3 and entries with none as one count line each, their lines left to
// dossier.md. Groups are blank-line separated, so a relayed digest rendered
// as Markdown never folds a group's heading into the item above it.
const priorityGroups = (view: DossierView): ReadonlyArray<ReadonlyArray<string>> => {
  const entries = [...view.findings, ...view.unresolved]
  if (entries.length === 0) return [["No findings."]]
  const groups = [
    { heading: "P1", priority: "P1", listed: true },
    { heading: "P2", priority: "P2", listed: true },
    { heading: "P3", priority: "P3", listed: false },
    { heading: "No priority", priority: undefined, listed: false },
  ] as const
  return Array.flatMap(groups, ({ heading, priority, listed }) => {
    const group = Array.filter(entries, (entry) => entry.reviewPriority === priority)
    if (group.length === 0) return []
    const counted = `${heading} (${String(group.length)})`
    return [
      listed
        ? [counted, ...Array.map(group, entryLine)]
        : [`${counted} in dossier.md: ${tagCounts(group)}`],
    ]
  })
}

const stageLabel = (stage: SeatedStageName): string =>
  `${stage.charAt(0).toUpperCase()}${stage.slice(1)}`

// Tokens, never dollars: one line per seated Stage plus the Run's total.
const tokenLines = (accounting: RunAccounting): ReadonlyArray<string> => [
  "Tokens:",
  ...Array.map(SeatedStageName.literals, (stage) =>
    `- ${stageLabel(stage)}: ${describeTokens(accounting.stageTokens[stage])}`),
  `- Total: ${describeTokens(totalTokens(accounting.stageTokens))}`,
]

// The bounded stdout digest (ADR 0005): the tally line (counts, target,
// recipe, wall time), coverage gaps, the findings grouped by Review Priority,
// the token lines, then the path to dossier.md. Finder cache health stays in
// dossier.md: an agent relaying the digest called it out as if it were a
// finding (#138). Refuted, dropped, and evidence live only in the run dir.
export const renderDigest = (
  plan: ReviewPlan,
  dossier: Dossier,
  accounting: RunAccounting,
  dossierMarkdownPath: string,
): string => {
  const view = viewDossier(dossier)
  const recipeName = plan.recipeName ?? "none"
  const count = (
    entries: ReadonlyArray<DossierEntryView>,
    tag: DossierEntryView["tag"],
  ) => String(Array.filter(entries, (entry) => entry.tag === tag).length)
  const tally =
    `${count(view.findings, "confirmed")} confirmed · ${count(view.findings, "judgment")} kept · ` +
    `${count(view.unresolved, "plausible")} plausible · ${count(view.unresolved, "undecided")} undecided — ` +
    `${describeTargetShort(dossier.target)} — recipe: ${recipeName} — ` +
    `${accounting.wallTimeSeconds}s`
  // A review missing work must say so where the agent relays it: a run whose
  // every Finder failed otherwise reads as a clean zero (ADR 0005, #137).
  const coverageGaps = dossier.coverageGaps.length === 0
    ? []
    : [boundedLine(
      `coverage gaps: ${String(dossier.coverageGaps.length)} — ${
        pipe(dossier.coverageGaps, Array.map((gap) =>
          `${gap.lens ?? gap.stage} (${gap.reason})`), Array.join("; "))
      }`,
    )]
  const toolHealth = accounting.finderToolHealth !== undefined &&
      isFinderToolCascade(accounting.finderToolHealth)
    ? [boundedLine(
      `tool health: ${describeFinderToolHealth(accounting.finderToolHealth)}`,
    )]
    : []
  // A lens that doesn't apply is skipped by design, not missing work, so it
  // is named apart from the coverage gaps: otherwise only dossier.md says it
  // never ran.
  const skipped = selectRunnableFinders(plan).skipped
  const notRun = skipped.length === 0
    ? []
    : [`Not run: ${pipe(skipped, Array.map(({ lens, reason }) => `${lens.name} (${reason})`), Array.join(", "))}`]
  return Array.join([
    tally,
    ...coverageGaps,
    ...toolHealth,
    ...notRun,
    ...Array.flatMap(priorityGroups(view), (group) => ["", ...group]),
    "",
    ...tokenLines(accounting),
    "",
    `dossier.md: ${dossierMarkdownPath}`,
  ], "\n")
}
