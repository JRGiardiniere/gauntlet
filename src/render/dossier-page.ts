// The Dossier page: one Run's Dossier as a single offline HTML file, written
// beside dossier.md. dossier.md stays the Dossier; this is a reading of it
// for a person — each finding an exhibit, its claim beside the reviewed code.
// Deterministic from the frozen plan, the Dossier, the page's data and any
// briefs: no model calls, no clock (ADR 0006). The data — the Run's accounting
// and the reviewed files — rides inside the page, so adding a brief later
// redraws it from what the Run saw, not from the code as it is now.
import type { Candidate } from "../domain/candidate.ts"
import type { Dossier } from "../domain/dossier.ts"
import { selectRunnableFinders } from "../domain/finder-selection.ts"
import type { ReviewPlan } from "../domain/review-plan.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import type { ReviewPriority } from "../domain/verdict.ts"
import * as Schema from "effect/Schema"
import type { RunAccounting } from "../run/run-accounting.ts"
import { renderBrief, type RenderedBrief } from "./brief.ts"
import {
  escapeHtml,
  type Hunk,
  hunkAt,
  lineHighlighter,
  parseDiffHunks,
} from "./code-text.ts"
import { DOSSIER_PAGE_CSS, DOSSIER_PAGE_SCRIPT } from "./dossier-page-assets.ts"
import {
  code,
  CONTEXT,
  excerpt,
  frame,
  ICON,
  inline,
  paragraphs,
  pinTail,
} from "./page-frames.ts"
import { describeRecipe, describeRunNotes } from "./dossier-markdown.ts"
import {
  type DossierEntryTag,
  type DossierEntryView,
  viewDossier,
} from "./dossier-view.ts"

export const DossierPageData = Schema.Struct({
  costUsd: Schema.Finite,
  invocationCount: Schema.Int,
  wallTimeSeconds: Schema.Int,
  runNotes: Schema.Array(Schema.String),
  // Reviewed files by repository path, as lines: the head commit plus, for a
  // working tree, its overlay.
  sources: Schema.Record(Schema.String, Schema.Array(Schema.String)),
})
export type DossierPageData = typeof DossierPageData.Type

export const dossierPageData = (
  accounting: RunAccounting,
  sources: ReadonlyMap<string, ReadonlyArray<string>>,
): DossierPageData => ({
  costUsd: accounting.costUsd,
  invocationCount: accounting.invocationCount,
  wallTimeSeconds: accounting.wallTimeSeconds,
  runNotes: describeRunNotes(accounting),
  sources: Object.fromEntries(sources),
})

const DATA_ELEMENT = /<script type="application\/json" id="dossier-page-data">(.*?)<\/script>/s

// The data a page was drawn from, as its JSON text.
export const pageDataText = (page: string): string | undefined =>
  DATA_ELEMENT.exec(page)?.[1]

export interface DossierPageInput {
  readonly plan: ReviewPlan
  readonly dossier: Dossier
  readonly data: DossierPageData
  readonly runDirectory: string
  // Brief markdown by finding id.
  readonly briefs?: ReadonlyMap<string, string>
  // Lines the briefs show beyond the reviewed files, by sourceKey.
  readonly extraSources?: ReadonlyMap<string, ReadonlyArray<string>>
}

export interface DrawnDossierPage {
  readonly html: string
  // Briefs the page could not draw whole, worded for the agent that wrote
  // them.
  readonly problems: ReadonlyArray<string>
}

// ---------------------------------------------------------------------------
// Which reviewed files a page reads

// `file.ts:12` or `file.ts:12-18` cited in a reason or failure scenario.
const CITATION =
  /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:[cm]?[jt]sx?|json|md)):(\d+)(?:[-–](\d+))?/g

// A name cited in model prose ("engine.ts:349") resolved to one known path,
// preferring the finding's own directory when the name is ambiguous.
const resolveCited = (
  name: string,
  near: string,
  known: ReadonlyArray<string>,
): string | undefined => {
  if (known.includes(name)) return name
  const hits = known.filter((path) => path.endsWith(`/${name}`))
  if (hits.length === 1) return hits[0]
  const directory = near.slice(0, near.lastIndexOf("/") + 1)
  const local = hits.filter((path) => path.startsWith(directory))
  return local.length === 1 ? local[0] : undefined
}

const pageEntries = (dossier: Dossier) => {
  const view = viewDossier(dossier)
  return [...view.findings, ...view.unresolved]
}

const prose = (entry: DossierEntryView): ReadonlyArray<string> => [
  entry.detail ?? "",
  entry.candidate._tag === "BugClaim" ? entry.candidate.failureScenario : "",
]

// The reviewed files an exhibit can show: each finding's own file and the
// files its evaluator cites, resolved against the paths the Run knows.
export const dossierPageFiles = (
  plan: ReviewPlan,
  dossier: Dossier,
): ReadonlyArray<string> => {
  const entries = pageEntries(dossier)
  const known = [
    ...new Set([
      ...plan.target.changedFiles,
      ...entries.flatMap(({ candidate }) => [
        candidate.file,
        ...(candidate.sourceReferences ?? []),
      ]),
    ]),
  ]
  const files = new Set(entries.map(({ candidate }) => candidate.file))
  for (const entry of entries) {
    for (const text of prose(entry)) {
      for (const match of text.matchAll(CITATION)) {
        const path = resolveCited(match[1] ?? "", entry.candidate.file, known)
        if (path !== undefined) files.add(path)
      }
    }
  }
  return [...files]
}

// ---------------------------------------------------------------------------
// Evidence

// The claim's first sentence leads; the rest follows it as body.
const splitLead = (summary: string) => {
  if (summary.length <= 150) return { lead: summary, rest: "" }
  const match = /^(.{40,220}?[.!?])\s+(?=[A-Z`(])/.exec(summary)
  return match === null
    ? { lead: summary, rest: "" }
    : { lead: match[1] ?? summary, rest: summary.slice(match[0].length) }
}

const WINDOW = 9
const SIGN = { context: " ", added: "+", removed: "−" } as const
const ROW = { context: "ctx", added: "add", removed: "del" } as const

const change = (file: string, hunk: Hunk, line: number | undefined, pin: string) => {
  const found = hunk.rows.findIndex((row) => row.newLine === line)
  const at = found === -1 ? 0 : found
  const whole = hunk.rows.length <= WINDOW * 2 + 6
  const low = whole ? 0 : Math.max(0, at - WINDOW)
  const high = whole ? hunk.rows.length : Math.min(hunk.rows.length, at + WINDOW + 1)
  const highlight = lineHighlighter(file)
  const fold = (count: number) =>
    `<div class="row fold"><span class="no"></span><span class="no"></span><span class="sign"></span><span class="src">${count} more line${count === 1 ? "" : "s"} in this hunk</span></div>`
  const rows = low > 0 ? [fold(low)] : []
  for (const row of hunk.rows.slice(low, high)) {
    const mark = line !== undefined && row.newLine === line
    rows.push(
      `<div class="row ${ROW[row.kind]}${mark ? " mark" : ""}"><span class="no">${row.oldLine ?? ""}</span><span class="no">${row.newLine ?? ""}</span><span class="sign">${SIGN[row.kind]}</span><span class="src">${
        highlight(row.text) || " "
      }</span>${mark ? pinTail(pin) : ""}</div>`,
    )
  }
  if (high < hunk.rows.length) rows.push(fold(hunk.rows.length - high))
  const added = hunk.rows[at]?.kind === "added"
  return frame(
    `<span class="ev-kind">Change</span><code>${escapeHtml(file)}${line === undefined ? "" : `:${line}`}</code><span class="ev-rev">${
      added ? "line added in this change" : "inside a changed hunk"
    }</span>`,
    code(rows, " diff"),
  )
}

interface PageSources {
  readonly hunks: ReadonlyMap<string, ReadonlyArray<Hunk>>
  readonly files: ReadonlyMap<string, ReadonlyArray<string>>
}

// An exhibit's proof: the changed hunk at the finding's line, or the lines
// around it, then up to three places its evaluator cites.
const evidence = (sources: PageSources, entry: DossierEntryView, pin: string) => {
  const { file, line } = entry.candidate
  const hunks = sources.hunks.get(file) ?? []
  const lines = sources.files.get(file)
  const own = line === undefined
    ? hunks[0] === undefined ? "" : change(file, hunks[0], undefined, pin)
    : (() => {
      const hunk = hunkAt(hunks, line)
      if (hunk !== undefined) return change(file, hunk, line, pin)
      return lines === undefined
        ? ""
        : excerpt({
          file,
          lines,
          from: line - CONTEXT,
          to: line + CONTEXT,
          marked: new Set([line]),
          pin,
        })
    })()
  const known = [...sources.files.keys()]
  const seen = new Set<string>()
  const cited: Array<string> = []
  for (const text of prose(entry)) {
    for (const match of text.matchAll(CITATION)) {
      const path = resolveCited(match[1] ?? "", file, known)
      const from = Number(match[2])
      const to = Math.min(match[3] === undefined ? from : Number(match[3]), from + 20)
      const key = `${path}:${from}`
      const nearOwn = path === file && line !== undefined && Math.abs(from - line) <= CONTEXT
      const pathLines = path === undefined ? undefined : sources.files.get(path)
      if (path === undefined || pathLines === undefined || nearOwn || seen.has(key) || seen.size >= 3) continue
      seen.add(key)
      const marked = new Set(Array.from({ length: to - from + 1 }, (_, i) => from + i))
      cited.push(excerpt({
        file: path,
        lines: pathLines,
        from: from - 3,
        to: to + 3,
        marked,
        pin,
        caption: "cited in the finding",
      }))
    }
  }
  return [own, ...cited].join("")
}

// ---------------------------------------------------------------------------
// Exhibits

type Ink = ReviewPriority | "none"
const INK: Record<Ink, string> = {
  P1: "var(--p1)",
  P2: "var(--p2)",
  P3: "var(--p3)",
  none: "var(--ink-3)",
}

const STAMP: Record<DossierEntryTag, { readonly word: string; readonly by: string }> = {
  confirmed: { word: "Confirmed", by: "Verification" },
  judgment: { word: "Kept", by: "Judgment" },
  plausible: { word: "Plausible", by: "Verification" },
  undecided: { word: "Undecided", by: "Judgment" },
  refuted: { word: "Refuted", by: "Verification" },
  dropped: { word: "Dropped", by: "Judgment" },
}

const location = (candidate: Candidate) =>
  candidate.line === undefined ? candidate.file : `${candidate.file}:${candidate.line}`

const stamp = (entry: DossierEntryView, small = false) => {
  const ink: Ink = entry.reviewPriority ?? "none"
  return `<div class="stamp st-${ink} st-${entry.tag}${small ? " st-small" : ""}" style="--ink:${INK[ink]}"><span class="st-word">${
    STAMP[entry.tag].word
  }</span><span class="st-by">${STAMP[entry.tag].by}${
    entry.reviewPriority === undefined ? "" : ` · ${entry.reviewPriority}`
  }</span></div>`
}

// The findings a person has to think about: kept Observations and the
// claims and Observations nobody could settle.
const needsThought = (entry: DossierEntryView) =>
  entry.tag === "judgment" || entry.tag === "plausible" || entry.tag === "undecided"

interface Filed {
  readonly entry: DossierEntryView
  readonly number: string
  readonly brief?: RenderedBrief
}

const field = (label: string, body: string) =>
  `<div class="field"><span class="field-label">${label}</span><div class="field-body">${body}</div></div>`

const exhibit = (
  sources: PageSources,
  { brief, entry, number }: Filed,
  runId: string,
  runDirectory: string,
) => {
  const { candidate } = entry
  const ink = INK[entry.reviewPriority ?? "none"]
  const { lead, rest } = splitLead(candidate.summary)
  const finding = entry.detail === undefined
    ? ""
    : field(`Finding of ${STAMP[entry.tag].by}`, paragraphs(entry.detail))
  const scenario = candidate._tag === "BugClaim"
    ? field("Failure scenario", paragraphs(candidate.failureScenario))
    : ""
  const tests = entry.testSuggestion === undefined
    ? ""
    : field(
      "Tests to run",
      `<p>${entry.testSuggestion.tests.map((test) => `<code>${escapeHtml(test)}</code>`).join(", ")} — ${
        inline(entry.testSuggestion.reason)
      }</p>`,
    )
  const prompt = needsThought(entry)
    ? `Write a brief for Gauntlet finding ${candidate.id} (${location(candidate)}): run \`gauntlet brief ${runId} ${candidate.id}\` and follow what it prints.`
    : `Explain Gauntlet finding ${candidate.id} (${location(candidate)}) from run ${runId}: read its entry in ${runDirectory}/dossier.json, check the code, and show me what goes wrong and how to fix it.`
  const handOff = brief !== undefined
    ? `<a class="act" href="#${number}-brief">${ICON.brief}<span>Read the brief</span></a>`
    : `<button type="button" class="act" data-copy="${escapeHtml(prompt)}" data-done="Prompt copied">${ICON.brief}<span>${
      needsThought(entry) ? "Ask for a brief" : "Explain"
    }</span></button>`
  const briefSheet = brief === undefined ? "" : `<section class="brief" id="${number}-brief" aria-label="Brief for ${number}">
      <header class="brief-head"><span class="clip">${ICON.clip}</span><span class="tag">Brief · ${number}</span><span class="brief-by">written by an agent, from the Dossier and the code</span></header>
      ${brief.takeaway === undefined ? "" : `<p class="takeaway">${inline(brief.takeaway)}</p>`}
      ${brief.html}
    </section>`
  return `<article class="exhibit${needsThought(entry) ? " thought" : ""}" id="${number}" data-no="${number}" data-thought="${needsThought(entry)}" tabindex="-1" style="--ink:${ink}">
    <header class="ex-head">
      <span class="tag"><i class="hole" aria-hidden="true"></i>Exhibit ${number}</span>
      <code class="ex-loc">${escapeHtml(location(candidate))}</code>
      <span class="ex-lens">raised by ${entry.lenses.map(escapeHtml).join(", ")}</span>
      <span class="ex-marks"><span class="reviewed" aria-hidden="true">${ICON.check}<span>Reviewed</span></span>${stamp(entry)}</span>
    </header>
    <div class="ex-body">
      <div class="claim">
        <p class="lead">${inline(lead)}</p>
        ${rest === "" ? "" : `<p class="rest">${inline(rest)}</p>`}
        ${finding}${scenario}${tests}
        <div class="acts">
          <button type="button" class="act act-review" data-review>${ICON.check}<span>Stamp reviewed</span><kbd>x</kbd></button>
          <button type="button" class="act" data-copy="${escapeHtml(location(candidate))}" data-done="Copied">${ICON.copy}<span>Copy location</span></button>
          ${handOff}
        </div>
      </div>
      <div class="proof">${evidence(sources, entry, number)}</div>
    </div>
    ${briefSheet}
  </article>`
}

// ---------------------------------------------------------------------------
// The page

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

// A run ID begins with its start time: 2026-10-10T03-05-46-670Z-167e.
const filedOn = (runId: string) => {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(runId)
  return match === null
    ? runId
    : `${Number(match[3])} ${MONTHS[Number(match[2]) - 1]} ${match[1]}, ${match[4]}:${match[5]} UTC`
}

const duration = (seconds: number) =>
  seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`

const basename = (path: string) => path.slice(path.lastIndexOf("/") + 1)
const short = (commit: string) => commit.slice(0, 7)

export const renderDossierPage = (input: DossierPageInput): DrawnDossierPage => {
  const { data, dossier, plan, runDirectory } = input
  const briefs = input.briefs ?? new Map<string, string>()
  const sources: PageSources = {
    hunks: parseDiffHunks(plan.target.diff),
    files: new Map(Object.entries(data.sources)),
  }
  const lookup = (key: string) => input.extraSources?.get(key) ?? sources.files.get(key)
  const problems: Array<string> = []
  const target = dossier.target
  const view = viewDossier(dossier)
  const numbered = (prefix: string) => (entry: DossierEntryView, index: number): Filed => {
    const number = `${prefix}-${String(index + 1).padStart(2, "0")}`
    const text = briefs.get(entry.candidate.id)
    if (text === undefined) return { entry, number }
    const brief = renderBrief(text, number, lookup)
    problems.push(...brief.problems.map((problem) => `briefs/${entry.candidate.id}.md: ${problem}`))
    return { entry, number, brief }
  }
  const findings = view.findings.map(numbered("E"))
  const unresolved = view.unresolved.map(numbered("U"))
  for (const id of briefs.keys()) {
    if (![...findings, ...unresolved].some(({ entry }) => entry.candidate.id === id)) {
      problems.push(`briefs/${id}.md: no finding or unresolved entry has the id ${id}`)
    }
  }
  const filed = [...findings, ...unresolved]
  const setAside = [...view.refutedClaims, ...view.droppedObservations]
  const ranked = (priority: ReviewPriority | undefined) =>
    findings.filter(({ entry }) => entry.reviewPriority === priority)

  const kind = TargetIdentity.match(target, {
    WorkingTree: () => "Working tree",
    Commits: () => "Commits",
    PullRequest: ({ number }) => `Pull request #${number}`,
  })
  const range = TargetIdentity.match(target, {
    WorkingTree: ({ headCommit }) => `working tree on ${short(headCommit)}`,
    Commits: ({ baseCommit, headCommit }) => `${short(baseCommit)}‥${short(headCommit)}`,
    PullRequest: ({ baseCommit, headCommit }) => `${short(baseCommit)}‥${short(headCommit)}`,
  })
  const subject = `${basename(target.repoRoot)}${
    TargetIdentity.match(target, {
      WorkingTree: () => "",
      Commits: () => "",
      PullRequest: ({ number }) => ` #${number}`,
    })
  }`

  const spineItem = ({ brief, entry, number }: Filed) =>
    `<li><a href="#${number}" data-for="${number}" data-thought="${needsThought(entry)}"><span class="ix">${number}</span><span class="sf">${
      escapeHtml(basename(location(entry.candidate)))
    }</span>${brief === undefined ? "" : `<span class="sp-brief" title="Has a brief">${ICON.clip}</span>`}<span class="sp-check" aria-label="reviewed">${ICON.check}</span><span class="sp-flag" aria-label="you stopped here">${ICON.flag}</span></a></li>`
  const tabGroup = (label: string, style: string, items: ReadonlyArray<Filed>) =>
    `<div class="sp-group ${style}${items.length === 0 ? " empty" : ""}"><div class="sp-tab"><span>${label}</span><b>${items.length}</b></div>${
      items.length === 0 ? "" : `<ol>${items.map(spineItem).join("")}</ol>`
    }</div>`
  const unranked = ranked(undefined)
  const spine = `<nav class="spine" aria-label="Exhibits">
    <div class="sp-mark"><span class="diamond">◆</span> Gauntlet</div>
    <div class="sp-view" role="radiogroup" aria-label="Which exhibits">
      <button type="button" role="radio" aria-checked="true" data-view="all">All exhibits</button>
      <button type="button" role="radio" aria-checked="false" data-view="thought">Needs thought <b>${
    filed.filter(({ entry }) => needsThought(entry)).length
  }</b></button>
    </div>
    ${tabGroup("P1", "sp-p1", ranked("P1"))}
    ${tabGroup("P2", "sp-p2", ranked("P2"))}
    ${tabGroup("P3", "sp-p3", ranked("P3"))}
    ${unranked.length === 0 ? "" : tabGroup("Unranked", "sp-none", unranked)}
    ${tabGroup("Unresolved", "sp-unres", unresolved)}
    <div class="sp-group sp-aside${setAside.length === 0 ? " empty" : ""}"><a class="sp-tab" href="#set-aside"><span>Set aside</span><b>${setAside.length}</b></a></div>
    <div class="sp-progress"><span data-progress>0</span> of ${filed.length} reviewed</div>
  </nav>`

  const finders = selectRunnableFinders(plan)
  const { runNotes } = data
  const indexField = (label: string, value: string, style = "") =>
    `<div class="ix-field ${style}"><span class="field-label">${label}</span><span class="ix-value">${value}</span></div>`
  const muted = (text: string) => `<span class="muted">(${escapeHtml(text)})</span>`
  const indexSheet = `<header class="sheet index" id="index">
    <div class="ix-title">
      <h1><span class="diamond h-mark" aria-hidden="true">◆</span><span class="h-subject">${escapeHtml(subject)}</span> <span class="h-range">${escapeHtml(range)}</span></h1>
      <p class="ix-docket">
        ${
    (["P1", "P2", "P3"] as const).map((priority) => {
      const count = ranked(priority).length
      return `<span class="dk dk-${priority.toLowerCase()}${count === 0 ? " zero" : ""}"><b>${count}</b> ${priority}</span>`
    }).join("")
  }
        <span class="dk"><b>${unresolved.length}</b> unresolved</span>
        <span class="dk"><b>${setAside.length}</b> set aside</span>
      </p>
    </div>
    <div class="ix-grid">
      ${indexField("Case", `<code>${escapeHtml(dossier.runId)}</code>`, "w2")}
      ${indexField("Filed", escapeHtml(filedOn(dossier.runId)), "w2")}
      ${indexField("Subject", `${escapeHtml(kind)} in <code>${escapeHtml(target.repoRoot.replace(/^\/Users\/[^/]+/, "~"))}</code>`, "w2")}
      ${indexField("Cost", `$${data.costUsd.toFixed(2)}`, "num")}
      ${indexField("Invocations", String(data.invocationCount), "num")}
      ${indexField("Time", duration(data.wallTimeSeconds), "num")}
      ${
    indexField(
      "Not run",
      finders.skipped.length === 0
        ? "none"
        : finders.skipped.map(({ lens, reason }) => `${escapeHtml(lens.name)} ${muted(reason)}`).join("; "),
      "w3",
    )
  }
      <details class="ix-more" open><summary class="field-label">Tribunal, lenses and notes</summary><div class="ix-grid">
      ${indexField("Tribunal", escapeHtml(describeRecipe(plan)), "w6")}
      ${indexField("Lenses", finders.runnable.map((lens) => escapeHtml(lens.name)).join(", ") || "none", "w4")}
      ${
    indexField(
      "Coverage gaps",
      dossier.coverageGaps.length === 0
        ? "none"
        : dossier.coverageGaps.map((gap) => `${escapeHtml(gap.lens ?? gap.stage)} ${muted(gap.reason)}`).join("; "),
      dossier.coverageGaps.length === 0 ? "w2" : "w2 warn",
    )
  }
      ${plan.target.warnings.length === 0 ? "" : indexField("Warnings", plan.target.warnings.map(escapeHtml).join("; "), "w6")}
      ${runNotes.length === 0 ? "" : indexField("Run notes", runNotes.map(escapeHtml).join(" "), "w6")}
      </div></details>
    </div>
  </header>`

  const sectionHead = (title: string, note: string) =>
    `<h2 class="sec-head"><span>${title}</span><small>${note}</small></h2>`
  const asideRow = (entry: DossierEntryView) =>
    `<li class="aside-row"><div class="aside-top">${stamp(entry, true)}<code>${escapeHtml(location(entry.candidate))}</code><span class="ex-lens">raised by ${
      entry.lenses.map(escapeHtml).join(", ")
    }</span></div><p class="aside-claim">${inline(entry.candidate.summary)}</p>${
      entry.detail === undefined ? "" : `<p class="aside-why"><span class="field-label">Why</span> ${inline(entry.detail)}</p>`
    }</li>`
  const exhibits = (items: ReadonlyArray<Filed>) =>
    items.map((item) => exhibit(sources, item, dossier.runId, runDirectory)).join("")

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dossier ${escapeHtml(subject)} ${escapeHtml(range)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap">
<style>${DOSSIER_PAGE_CSS}</style>
</head>
<body data-run="${escapeHtml(dossier.runId)}">
${spine}
<main class="file">
  ${indexSheet}
  ${
    findings.length === 0
      ? `<section class="sheet clean"><p class="lead">Nothing held. Every candidate was refuted or dropped.</p></section>`
      : sectionHead("Findings", "in Review Priority order")
  }
  ${exhibits(findings)}
  ${unresolved.length === 0 ? "" : sectionHead("Unresolved", "Verification could neither confirm nor refute; Judgment said nothing")}
  ${exhibits(unresolved)}
  <details class="sheet sleeve" id="set-aside">
    <summary><span class="sleeve-title">Set aside</span><span class="muted">${view.refutedClaims.length} refuted by Verification · ${view.droppedObservations.length} dropped by Judgment</span></summary>
    <ol class="aside">${setAside.map(asideRow).join("")}</ol>
  </details>
  <footer class="colophon"><code>dossier.md</code> is the Dossier; this page is a reading of it. Code as reviewed at <code>${escapeHtml(short(target.headCommit))}</code>.</footer>
</main>
<script type="application/json" id="dossier-page-data">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>
<script>${DOSSIER_PAGE_SCRIPT}</script>
</body>
</html>
`
  return { html, problems }
}
