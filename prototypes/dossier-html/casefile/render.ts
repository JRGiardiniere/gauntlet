// The Case File: one Run's Dossier as a single offline HTML page.
//
//   bun render.ts <run-dir> <out.html> [briefs.json]
//
// Every exhibit is projected into typed blocks (markdown, code, diff,
// diagram, before-after, snippet) and drawn by one renderer. A brief is the
// same blocks written by an agent for a Judgment-path finding; it is clipped
// to its exhibit. Agents supply content and source references, never markup:
// a code or diff block names a file and lines, and the renderer reads them
// from git. No clock, no randomness: the same inputs render the same bytes.
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { CITATION, type Entry, type EntryTag, esc, highlighter, type Priority, readHeaderFacts, Repo, viewDossier } from "./data.ts"
import type { Dossier } from "./data.ts"

// ---------------------------------------------------------------------------
// Blocks: the whole authoring vocabulary.

interface DiagramNode { id: string; label: string; note?: string; tone?: "accent" | "state" | "muted" }
interface DiagramEdge { from: string; to: string; label?: string; kind?: "calls" | "writes" | "reads" }
type Block =
  | { type: "markdown"; text: string }
  | { type: "code"; file: string; rev?: string; startLine: number; endLine?: number; mark?: Array<number>; caption?: string }
  | { type: "diff"; file: string; line?: number; caption?: string }
  | { type: "snippet"; language?: string; source: string; caption?: string }
  | { type: "diagram"; nodes: Array<DiagramNode>; edges: Array<DiagramEdge>; caption?: string }
  | { type: "before-after"; before: { label: string; blocks: Array<Block> }; after: { label: string; blocks: Array<Block> } }

interface Brief { finding: string; takeaway: string; blocks: Array<Block> }

interface Ctx { repo: Repo; pin: string; ink: string; uid: () => string }

// ---------------------------------------------------------------------------
// Inline markdown: paragraphs, lists, `code`, **strong**, *em*.

const inline = (text: string) =>
  esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")

const markdown = (text: string) =>
  text.trim().split(/\n{2,}/).map((para) => {
    const lines = para.split("\n")
    if (lines.every((l) => /^\s*[-*] /.test(l))) {
      return `<ul>${lines.map((l) => `<li>${inline(l.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`
    }
    return `<p>${inline(para.replace(/\n/g, " "))}</p>`
  }).join("")

// ---------------------------------------------------------------------------
// Authored icons, one stroke weight.

const ICON = {
  check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6l3 3 6.6-7.2"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 3.2V2.8a.8.8 0 00-.8-.8H3.3a.8.8 0 00-.8.8v6.4c0 .4.4.8.8.8h.4"/></svg>`,
  flag: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14.5V2"/><path d="M4 2.5h8.2l-1.8 3 1.8 3H4"/></svg>`,
  clip: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 5.2l-4.4 4.4a1.3 1.3 0 001.8 1.8l5-5a2.6 2.6 0 00-3.7-3.7l-5.2 5.2a3.9 3.9 0 005.5 5.5l3.9-3.9"/></svg>`,
  brief: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.8 8.5h4.4M5.8 11h4.4"/></svg>`,
}

// ---------------------------------------------------------------------------
// Evidence renderers.

const pinTail = (pin: string) => `<span class="leader" aria-hidden="true"></span><span class="pin">${esc(pin)}</span>`

const frame = (head: string, body: string, caption?: string) =>
  `<figure class="evidence"><figcaption class="ev-head">${head}</figcaption>${body}${caption === undefined ? "" : `<p class="ev-caption">${inline(caption)}</p>`}</figure>`

const codeBlock = (b: Extract<Block, { type: "code" }>, ctx: Ctx) => {
  const rev = b.rev ?? ctx.repo.head
  const lines = ctx.repo.lines(b.file, rev)
  if (lines === undefined) return ""
  const end = Math.min(lines.length, b.endLine ?? b.startLine)
  const marks = new Set(b.mark ?? [])
  const hl = highlighter(b.file)
  for (let i = Math.max(0, b.startLine - 40); i < b.startLine - 1; i++) hl(lines[i]!)
  const rows: Array<string> = []
  for (let no = b.startLine; no <= end; no++) {
    const marked = marks.has(no)
    rows.push(`<div class="row${marked ? " mark" : ""}"><span class="no">${no}</span><span class="src">${hl(lines[no - 1]!) || " "}</span>${marked ? pinTail(ctx.pin) : ""}</div>`)
  }
  return frame(
    `<span class="ev-kind">Source</span><code>${esc(b.file)}:${b.startLine}${end > b.startLine ? `–${end}` : ""}</code><span class="ev-rev">@${esc(rev.slice(0, 7))}</span>`,
    `<div class="code"><div class="code-inner">${rows.join("")}</div></div>`,
    b.caption,
  )
}

const diffBlock = (b: Extract<Block, { type: "diff" }>, ctx: Ctx) => {
  const hunks = ctx.repo.hunks(b.file)
  const hunk = b.line === undefined
    ? hunks[0]
    : hunks.find((h) => b.line! >= h.newStart && b.line! < h.newStart + Math.max(h.newLen, 1))
  if (hunk === undefined) return ""
  let at = hunk.rows.findIndex((r) => r.newNo === b.line)
  if (at === -1) at = 0
  const WINDOW = 9
  const whole = hunk.rows.length <= WINDOW * 2 + 6
  const lo = whole ? 0 : Math.max(0, at - WINDOW)
  const hi = whole ? hunk.rows.length : Math.min(hunk.rows.length, at + WINDOW + 1)
  const hl = highlighter(b.file)
  const sign = { ctx: " ", add: "+", del: "−" } as const
  const fold = (n: number) => `<div class="row fold"><span class="no"></span><span class="no"></span><span class="sign"></span><span class="src">${n} more line${n === 1 ? "" : "s"} in this hunk</span></div>`
  const rows = [lo > 0 ? fold(lo) : ""]
  for (const r of hunk.rows.slice(lo, hi)) {
    const marked = b.line !== undefined && r.newNo === b.line
    rows.push(`<div class="row ${r.kind}${marked ? " mark" : ""}"><span class="no">${r.oldNo ?? ""}</span><span class="no">${r.newNo ?? ""}</span><span class="sign">${sign[r.kind]}</span><span class="src">${hl(r.text) || " "}</span>${marked ? pinTail(ctx.pin) : ""}</div>`)
  }
  if (hi < hunk.rows.length) rows.push(fold(hunk.rows.length - hi))
  const added = hunk.rows[at]?.kind === "add"
  return frame(
    `<span class="ev-kind">Change</span><code>${esc(b.file)}${b.line === undefined ? "" : `:${b.line}`}</code><span class="ev-rev">${added ? "line added in this range" : "inside a changed hunk"}</span>`,
    `<div class="code diff"><div class="code-inner">${rows.join("")}</div></div>`,
    b.caption,
  )
}

const snippetBlock = (b: Extract<Block, { type: "snippet" }>) => {
  const hl = highlighter(`x.${b.language ?? "ts"}`)
  const rows = b.source.replace(/\n$/, "").split("\n").map((l) => `<div class="row"><span class="src">${hl(l) || " "}</span></div>`)
  return frame(`<span class="ev-kind">Illustration</span><span class="ev-rev">not from the repository</span>`, `<div class="code snippet"><div class="code-inner">${rows.join("")}</div></div>`, b.caption)
}

// A layered left-to-right drawing: a node's column is its longest path from
// a source; edges are curves, styled by what they do.
const diagramBlock = (b: Extract<Block, { type: "diagram" }>, ctx: Ctx) => {
  const ids = b.nodes.map((n) => n.id)
  const rank = new Map(ids.map((id) => [id, 0]))
  for (let pass = 0; pass < ids.length; pass++) {
    for (const e of b.edges) {
      const r = (rank.get(e.from) ?? 0) + 1
      if (e.from !== e.to && r > (rank.get(e.to) ?? 0) && r < ids.length) rank.set(e.to, r)
    }
  }
  const CH = 7.6
  const size = (n: DiagramNode) => ({
    w: Math.min(260, Math.max(n.label.length * CH, (n.note?.length ?? 0) * 6.1) + 28),
    h: n.note === undefined ? 34 : 50,
  })
  const columns: Array<Array<DiagramNode>> = []
  for (const n of b.nodes) (columns[rank.get(n.id)!] ??= []).push(n)
  const GAP_X = 96
  const GAP_Y = 18
  const colW = columns.map((col) => Math.max(...col.map((n) => size(n).w)))
  const colH = columns.map((col) => col.reduce((s, n) => s + size(n).h, 0) + GAP_Y * (col.length - 1))
  const H = Math.max(...colH) + 16
  const pos = new Map<string, { x: number; y: number; w: number; h: number }>()
  let x = 8
  columns.forEach((col, c) => {
    let y = (H - colH[c]!) / 2
    for (const n of col) {
      const s = size(n)
      pos.set(n.id, { x: x + (colW[c]! - s.w) / 2, y, ...s })
      y += s.h + GAP_Y
    }
    x += colW[c]! + GAP_X
  })
  const W = x - GAP_X + 8
  const id = ctx.uid()
  const edges = b.edges.map((e) => {
    const a = pos.get(e.from)
    const t = pos.get(e.to)
    if (a === undefined || t === undefined) return ""
    const kind = e.kind ?? "calls"
    let d: string
    let mx: number
    let my: number
    if (t.x > a.x + a.w) {
      const x1 = a.x + a.w, y1 = a.y + a.h / 2, x2 = t.x - 3, y2 = t.y + t.h / 2
      const k = (x2 - x1) * 0.5
      d = `M${x1} ${y1}C${x1 + k} ${y1} ${x2 - k} ${y2} ${x2} ${y2}`
      mx = x2 - 8
      my = y2 - 2
    } else {
      const down = t.y > a.y
      const x1 = a.x + a.w / 2, y1 = down ? a.y + a.h : a.y, x2 = t.x + t.w / 2, y2 = down ? t.y - 3 : t.y + t.h + 3
      d = `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`
      mx = (x1 + x2) / 2 + 10
      my = (y1 + y2) / 2
    }
    const label = e.label === undefined ? "" : `<text class="dg-elabel" x="${mx.toFixed(1)}" y="${(my - 4).toFixed(1)}" text-anchor="end">${esc(e.label)}</text>`
    return `<path class="dg-edge dg-${kind}" d="${d}" marker-end="url(#${id}-${kind})"/>${label}`
  }).join("")
  const nodes = b.nodes.map((n) => {
    const p = pos.get(n.id)!
    const note = n.note === undefined ? "" : `<text class="dg-note" x="${(p.x + p.w / 2).toFixed(1)}" y="${(p.y + 38).toFixed(1)}" text-anchor="middle">${esc(n.note)}</text>`
    return `<g class="dg-node dg-${n.tone ?? "plain"}"><rect x="${p.x.toFixed(1)}" y="${p.y.toFixed(1)}" width="${p.w.toFixed(1)}" height="${p.h}" rx="3"/><text class="dg-label" x="${(p.x + p.w / 2).toFixed(1)}" y="${(p.y + 21).toFixed(1)}" text-anchor="middle">${esc(n.label)}</text>${note}</g>`
  }).join("")
  const marker = (kind: string) =>
    `<marker id="${id}-${kind}" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path class="dg-head dg-${kind}" d="M0.5 0.8L7.2 4L0.5 7.2"/></marker>`
  const svg = `<svg class="diagram" viewBox="0 0 ${W.toFixed(0)} ${H.toFixed(0)}" width="${W.toFixed(0)}" style="--ink:${ctx.ink}" role="img" aria-label="${esc(b.caption ?? "diagram")}"><defs>${marker("calls")}${marker("writes")}${marker("reads")}</defs>${edges}${nodes}</svg>`
  const legend = `<span class="dg-legend"><i class="lg-calls"></i>calls<i class="lg-writes"></i>writes<i class="lg-reads"></i>reads</span>`
  return frame(`<span class="ev-kind">Diagram</span>${legend}`, `<div class="dg-wrap">${svg}</div>`, b.caption)
}

const beforeAfter = (b: Extract<Block, { type: "before-after" }>, ctx: Ctx): string => {
  const id = ctx.uid()
  return `<div class="ba" data-ba="${id}">
    <div class="ba-switch" role="tablist"><button type="button" role="tab" aria-selected="true" data-side="before">Before <span>${esc(b.before.label)}</span></button><button type="button" role="tab" aria-selected="false" data-side="after">After <span>${esc(b.after.label)}</span></button></div>
    <div class="ba-pane" data-pane="before">${b.before.blocks.map((x) => block(x, ctx)).join("")}</div>
    <div class="ba-pane" data-pane="after" hidden>${b.after.blocks.map((x) => block(x, ctx)).join("")}</div>
  </div>`
}

const block = (b: Block, ctx: Ctx): string => {
  switch (b.type) {
    case "markdown":
      return `<div class="prose">${markdown(b.text)}</div>`
    case "code":
      return codeBlock(b, ctx)
    case "diff":
      return diffBlock(b, ctx)
    case "snippet":
      return snippetBlock(b)
    case "diagram":
      return diagramBlock(b, ctx)
    case "before-after":
      return beforeAfter(b, ctx)
  }
}

// ---------------------------------------------------------------------------
// The deterministic projection: a finding as the blocks of its exhibit.

const INK: Record<Priority | "none", string> = { P1: "var(--p1)", P2: "var(--p2)", P3: "var(--p3)", none: "var(--ink-3)" }

const location = (e: Entry) => (e.candidate.line === undefined ? e.candidate.file : `${e.candidate.file}:${e.candidate.line}`)

const evidenceOf = (repo: Repo, e: Entry): Array<Block> => {
  const c = e.candidate
  const out: Array<Block> = []
  const changed = repo.hunks(c.file)
  if (c.line === undefined) {
    if (changed.length > 0) out.push({ type: "diff", file: c.file })
  } else if (changed.some((h) => c.line! >= h.newStart && c.line! < h.newStart + Math.max(h.newLen, 1))) {
    out.push({ type: "diff", file: c.file, line: c.line })
  } else {
    out.push({ type: "code", file: c.file, startLine: Math.max(1, c.line - 6), endLine: c.line + 6, mark: [c.line] })
  }
  // Lines the evaluator's own words cite, resolved against the reviewed tree.
  const seen = new Set<string>()
  for (const text of [e.detail ?? "", c.failureScenario ?? ""]) {
    for (const m of text.matchAll(CITATION)) {
      const path = repo.resolve(m[1]!, c.file)
      if (path === undefined) continue
      const from = Number(m[2])
      const to = Math.min(m[3] === undefined ? from : Number(m[3]), from + 20)
      if (path === c.file && c.line !== undefined && Math.abs(from - c.line) <= 6) continue
      const key = `${path}:${from}`
      if (seen.has(key) || seen.size >= 3) continue
      seen.add(key)
      const marks = Array.from({ length: to - from + 1 }, (_, i) => from + i)
      out.push({ type: "code", file: path, startLine: Math.max(1, from - 3), endLine: to + 3, mark: marks, caption: "cited in the finding" })
    }
  }
  return out
}

// The claim's first sentence leads; the rest follows it as body.
const splitLead = (summary: string) => {
  if (summary.length <= 150) return { lead: summary, rest: "" }
  const m = /^(.{40,220}?[.!?])\s+(?=[A-Z`(])/.exec(summary)
  return m === null ? { lead: summary, rest: "" } : { lead: m[1]!, rest: summary.slice(m[0].length) }
}

const STAMP: Record<EntryTag, { word: string; by: string }> = {
  confirmed: { word: "Confirmed", by: "Verification" },
  judgment: { word: "Kept", by: "Judgment" },
  plausible: { word: "Plausible", by: "Verification" },
  undecided: { word: "Undecided", by: "Judgment" },
  refuted: { word: "Refuted", by: "Verification" },
  dropped: { word: "Dropped", by: "Judgment" },
}

const stamp = (e: Entry, small = false) =>
  `<div class="stamp st-${e.priority ?? "none"} st-${e.tag}${small ? " st-small" : ""}" style="--ink:${INK[e.priority ?? "none"]}"><span class="st-word">${STAMP[e.tag].word}</span><span class="st-by">${STAMP[e.tag].by}${e.priority === undefined ? "" : ` · ${e.priority}`}</span></div>`

const needsThought = (e: Entry) => e.tag === "judgment" || e.tag === "plausible" || e.tag === "undecided"

interface Filed { entry: Entry; no: string; anchor: string }

const exhibit = (repo: Repo, f: Filed, brief: Brief | undefined, runId: string, runDir: string, uid: () => string) => {
  const e = f.entry
  const c = e.candidate
  const ink = INK[e.priority ?? "none"]
  const ctx: Ctx = { repo, pin: f.no, ink, uid }
  const { lead, rest } = splitLead(c.summary)
  const finding = e.detail === undefined ? "" : `<div class="field"><span class="field-label">Finding of ${STAMP[e.tag].by}</span><div class="field-body">${markdown(e.detail)}</div></div>`
  const scenario = c.failureScenario === undefined ? "" : `<div class="field"><span class="field-label">Failure scenario</span><div class="field-body">${markdown(c.failureScenario)}</div></div>`
  const tests = e.testSuggestion === undefined ? "" : `<div class="field"><span class="field-label">Tests to run</span><div class="field-body"><p>${e.testSuggestion.tests.map((t) => `<code>${esc(t)}</code>`).join(", ")} — ${inline(e.testSuggestion.reason)}</p></div></div>`
  const mates = e.mates.length === 0 ? "" : `<div class="field"><span class="field-label">Also raised as</span><div class="field-body"><ul>${e.mates.map((m) => `<li><code>${esc(m.file)}${m.line === undefined ? "" : `:${m.line}`}</code> by ${esc(m.lens)}</li>`).join("")}</ul></div></div>`
  const prompt = `Write a Gauntlet brief for finding ${c.id} (${location(e)}) from run ${runId}: read its entry in ${runDir}/dossier.json, then add the brief to ${runDir}/briefs.json.`
  const explain = `Explain Gauntlet finding ${c.id} (${location(e)}) from run ${runId}: read its entry in ${runDir}/dossier.json, check the code, and show me what goes wrong and how to fix it.`
  const briefAction = brief !== undefined
    ? `<a class="act" href="#${f.anchor}-brief">${ICON.brief}<span>Read the brief</span></a>`
    : needsThought(e)
    ? `<button type="button" class="act" data-copy="${esc(prompt)}" data-done="Prompt copied">${ICON.brief}<span>Ask for a brief</span></button>`
    : `<button type="button" class="act" data-copy="${esc(explain)}" data-done="Prompt copied">${ICON.brief}<span>Explain</span></button>`
  const briefSheet = brief === undefined ? "" : `<section class="brief" id="${f.anchor}-brief" aria-label="Brief for ${f.no}">
      <header class="brief-head"><span class="clip">${ICON.clip}</span><span class="tag">Brief · ${f.no}</span><span class="brief-by">written by the agent, from the Dossier and the code</span></header>
      <p class="takeaway">${inline(brief.takeaway)}</p>
      ${brief.blocks.map((b) => block(b, ctx)).join("")}
    </section>`
  return `<article class="exhibit${needsThought(e) ? " thought" : ""}" id="${f.anchor}" data-no="${f.no}" data-thought="${needsThought(e)}" tabindex="-1" style="--ink:${ink}">
    <header class="ex-head">
      <span class="tag"><i class="hole" aria-hidden="true"></i>Exhibit ${f.no}</span>
      <code class="ex-loc">${esc(location(e))}</code>
      <span class="ex-lens">raised by ${e.lenses.map(esc).join(", ")}</span>
      <span class="ex-marks"><span class="reviewed" aria-hidden="true">${ICON.check}<span>Reviewed</span></span>${stamp(e)}</span>
    </header>
    <div class="ex-body">
      <div class="claim">
        <p class="lead">${inline(lead)}</p>
        ${rest === "" ? "" : `<p class="rest">${inline(rest)}</p>`}
        ${finding}${scenario}${tests}${mates}
        <div class="acts">
          <button type="button" class="act act-review" data-review>${ICON.check}<span>Stamp reviewed</span><kbd>x</kbd></button>
          <button type="button" class="act" data-copy="${esc(location(e))}" data-done="Copied">${ICON.copy}<span>Copy location</span></button>
          ${briefAction}
        </div>
      </div>
      <div class="proof">${evidenceOf(repo, e).map((b) => block(b, ctx)).join("")}</div>
    </div>
    ${briefSheet}
  </article>`
}

// ---------------------------------------------------------------------------
// The page.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]
const filedOn = (runId: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})/.exec(runId)
  return m === null ? runId : `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]} ${m[1]}, ${m[4]}:${m[5]} UTC`
}
const duration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`)

const render = (runDir: string, briefsPath: string | undefined): string => {
  const dossier: Dossier = JSON.parse(readFileSync(join(runDir, "dossier.json"), "utf8"))
  const facts = readHeaderFacts(runDir)
  const t = dossier.target
  const repo = new Repo(t.repoRoot, t.baseCommit, t.headCommit)
  const view = viewDossier(dossier)
  const briefs: Array<Brief> = briefsPath !== undefined && existsSync(briefsPath) ? JSON.parse(readFileSync(briefsPath, "utf8")).briefs : []
  let n = 0
  const uid = () => `u${++n}`
  const two = (i: number) => String(i + 1).padStart(2, "0")
  const findings: Array<Filed> = view.findings.map((entry, i) => ({ entry, no: `E-${two(i)}`, anchor: `E-${two(i)}` }))
  const unresolved: Array<Filed> = view.unresolved.map((entry, i) => ({ entry, no: `U-${two(i)}`, anchor: `U-${two(i)}` }))
  const filed = [...findings, ...unresolved]
  const setAside = [...view.refuted, ...view.dropped]
  const briefFor = (f: Filed) => briefs.find((b) => b.finding === f.entry.candidate.id)

  const range = t._tag === "WorkingTree"
    ? `working tree on ${t.headCommit.slice(0, 7)}`
    : `${t.baseCommit!.slice(0, 7)}‥${t.headCommit.slice(0, 7)}`
  const subject = `${basename(t.repoRoot)}${t._tag === "PullRequest" ? ` #${t.number}` : ""}`
  const count = (p: Priority) => findings.filter((f) => f.entry.priority === p).length

  // The spine: a tab per section, each exhibit filed under it.
  const spineItem = (f: Filed) =>
    `<li><a href="#${f.anchor}" data-for="${f.anchor}" data-thought="${needsThought(f.entry)}"><span class="ix">${f.no}</span><span class="sf">${esc(basename(f.entry.candidate.file))}${f.entry.candidate.line === undefined ? "" : `:${f.entry.candidate.line}`}</span>${briefFor(f) === undefined ? "" : `<span class="sp-brief" title="Has a brief">${ICON.clip}</span>`}<span class="sp-check" aria-label="reviewed">${ICON.check}</span><span class="sp-flag" aria-label="you stopped here">${ICON.flag}</span></a></li>`
  const tabGroup = (label: string, cls: string, items: Array<Filed>, extra = "") =>
    `<div class="sp-group ${cls}${items.length === 0 ? " empty" : ""}"><div class="sp-tab"><span>${label}</span><b>${items.length}</b></div>${items.length === 0 ? "" : `<ol>${items.map(spineItem).join("")}</ol>`}${extra}</div>`
  const spine = `<nav class="spine" aria-label="Exhibits">
    <div class="sp-mark"><span class="diamond">◆</span> Gauntlet</div>
    <div class="sp-view" role="radiogroup" aria-label="Which exhibits">
      <button type="button" role="radio" aria-checked="true" data-view="all">All exhibits</button>
      <button type="button" role="radio" aria-checked="false" data-view="thought">Needs thought <b>${filed.filter((f) => needsThought(f.entry)).length}</b></button>
    </div>
    ${tabGroup("P1", "sp-p1", findings.filter((f) => f.entry.priority === "P1"))}
    ${tabGroup("P2", "sp-p2", findings.filter((f) => f.entry.priority === "P2"))}
    ${tabGroup("P3", "sp-p3", findings.filter((f) => f.entry.priority === "P3"))}
    ${findings.some((f) => f.entry.priority === undefined) ? tabGroup("Unranked", "sp-none", findings.filter((f) => f.entry.priority === undefined)) : ""}
    ${tabGroup("Unresolved", "sp-unres", unresolved)}
    <div class="sp-group sp-aside${setAside.length === 0 ? " empty" : ""}"><a class="sp-tab" href="#set-aside"><span>Set aside</span><b>${setAside.length}</b></a></div>
    <div class="sp-progress"><span data-progress>0</span> of ${filed.length} reviewed</div>
  </nav>`

  const field = (label: string, value: string, cls = "") => `<div class="ix-field ${cls}"><span class="field-label">${label}</span><span class="ix-value">${value}</span></div>`
  const seats = /^(\S+) \((.*)\)$/.exec(facts.recipe ?? "")
  const indexSheet = `<header class="sheet index" id="index">
    <div class="ix-title">
      <h1><span class="diamond h-mark" aria-hidden="true">◆</span><span class="h-subject">${esc(subject)}</span> <span class="h-range">${esc(range)}</span></h1>
      <p class="ix-docket">
        ${(["P1", "P2", "P3"] as const).map((p) => `<span class="dk dk-${p.toLowerCase()}${count(p) === 0 ? " zero" : ""}"><b>${count(p)}</b> ${p}</span>`).join("")}
        <span class="dk"><b>${unresolved.length}</b> unresolved</span>
        <span class="dk"><b>${setAside.length}</b> set aside</span>
      </p>
    </div>
    <div class="ix-grid">
      ${field("Case", `<code>${esc(dossier.runId)}</code>`, "w2")}
      ${field("Filed", esc(filedOn(dossier.runId)), "w2")}
      ${field("Subject", `${esc(t._tag === "PullRequest" ? `Pull request #${t.number}` : t._tag === "Commits" ? "Commits" : "Working tree")} in <code>${esc(t.repoRoot.replace(/^\/Users\/[^/]+/, "~"))}</code>`, "w2")}
      ${field("Cost", esc(facts.cost ?? "—"), "num")}
      ${field("Invocations", esc(facts.invocations ?? "—"), "num")}
      ${field("Time", facts.wallSeconds === undefined ? "—" : duration(facts.wallSeconds), "num")}
      ${field("Not run", facts.skipped.length === 0 ? "none" : facts.skipped.map((s) => `${esc(s.name)} <span class="muted">(${esc(s.reason)})</span>`).join("; "), "w3")}
      <details class="ix-more" open><summary class="field-label">Tribunal, lenses and notes</summary><div class="ix-grid">
      ${field("Tribunal", seats === null ? esc(facts.recipe ?? "—") : `<b>${esc(seats[1]!)}</b> · ${esc(seats[2]!)}`, "w6")}
      ${field("Lenses", facts.lenses.map((l) => esc(l.name)).join(", ") || "—", "w4")}
      ${field("Coverage gaps", dossier.coverageGaps.length === 0 ? "none" : dossier.coverageGaps.map((g) => `${esc(g.lens ?? g.stage)} <span class="muted">(${esc(g.reason)})</span>`).join("; "), dossier.coverageGaps.length === 0 ? "w2" : "w2 warn")}
      ${facts.runNotes.length === 0 ? "" : field("Run notes", facts.runNotes.map(esc).join(" "), "w6")}
      </div></details>
    </div>
  </header>`

  const sectionHead = (title: string, note: string) => `<h2 class="sec-head"><span>${title}</span><small>${note}</small></h2>`
  const asideRow = (e: Entry) =>
    `<li class="aside-row"><div class="aside-top">${stamp(e, true)}<code>${esc(location(e))}</code><span class="ex-lens">raised by ${e.lenses.map(esc).join(", ")}</span></div><p class="aside-claim">${inline(e.candidate.summary)}</p>${e.detail === undefined ? "" : `<p class="aside-why"><span class="field-label">Why</span> ${inline(e.detail)}</p>`}</li>`

  const body = `${spine}
  <main class="file">
    ${indexSheet}
    ${findings.length === 0 ? `<section class="sheet clean"><p class="lead">Nothing held. Every candidate was refuted or dropped.</p></section>` : sectionHead("Findings", "in Review Priority order")}
    ${findings.map((f) => exhibit(repo, f, briefFor(f), dossier.runId, runDir, uid)).join("")}
    ${unresolved.length === 0 ? "" : sectionHead("Unresolved", "Verification could neither confirm nor refute; Judgment said nothing")}
    ${unresolved.map((f) => exhibit(repo, f, briefFor(f), dossier.runId, runDir, uid)).join("")}
    <details class="sheet sleeve" id="set-aside">
      <summary><span class="sleeve-title">Set aside</span><span class="muted">${view.refuted.length} refuted by Verification · ${view.dropped.length} dropped by Judgment</span></summary>
      <ol class="aside">${setAside.map(asideRow).join("")}</ol>
    </details>
    <footer class="colophon">Rendered from <code>dossier.json</code>; <code>dossier.md</code> is the Dossier. Evidence read from git at <code>${esc(t.headCommit.slice(0, 7))}</code>.</footer>
  </main>`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dossier ${esc(subject)} ${esc(range)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..800&display=swap">
<style>${CSS}</style>
</head>
<body data-run="${esc(dossier.runId)}">
${body}
<script>${JS}</script>
</body>
</html>
`
}

// ---------------------------------------------------------------------------

const CSS = String.raw`
:root{
  --desk:#e6e0d3; --kraft:#c9a56b; --kraft-2:#b48f55; --kraft-ink:#2e2412; --kraft-ink-2:#5b4728;
  --sheet:#f8f6f0; --sheet-2:#f1ede3; --rule:#ddd5c4; --rule-2:#c9bfab;
  --ink-1:#1c1b18; --ink-2:#47433b; --ink-3:#6b6559;
  --p1:#d93b40; --p2:#e57a00; --p3:#b98f00; --mark:#d7875f;
  --add:#ebe6d9; --add-ink:#1c1b18; --del:#f3f0e8; --del-ink:#6b6559; --hl:#fff1c2;
  --shadow:0 1px 2px rgba(40,30,10,.10),0 6px 18px -6px rgba(40,30,10,.18);
  --blend:multiply;
  --cond:"Archivo","Arial Narrow",system-ui,sans-serif;
  --text:"Archivo",system-ui,-apple-system,"Segoe UI",sans-serif;
  --mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;
  color-scheme:light;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --desk:#121110; --kraft:#4a3920; --kraft-2:#5e4829; --kraft-ink:#f1dfbd; --kraft-ink-2:#c9b089;
  --sheet:#1c1b19; --sheet-2:#232220; --rule:#34312c; --rule-2:#47433b;
  --ink-1:#ece8df; --ink-2:#c3bcae; --ink-3:#958e80;
  --p1:#e5484d; --p2:#ff8700; --p3:#e0b000; --mark:#e89a72;
  --add:#34312c; --add-ink:#ece8df; --del:#1f1e1b; --del-ink:#958e80; --hl:#3a3216;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px -8px rgba(0,0,0,.6);
  --blend:screen; color-scheme:dark;
}}
:root[data-theme="dark"]{
  --desk:#121110; --kraft:#4a3920; --kraft-2:#5e4829; --kraft-ink:#f1dfbd; --kraft-ink-2:#c9b089;
  --sheet:#1c1b19; --sheet-2:#232220; --rule:#34312c; --rule-2:#47433b;
  --ink-1:#ece8df; --ink-2:#c3bcae; --ink-3:#958e80;
  --p1:#e5484d; --p2:#ff8700; --p3:#e0b000; --mark:#e89a72;
  --add:#34312c; --add-ink:#ece8df; --del:#1f1e1b; --del-ink:#958e80; --hl:#3a3216;
  --shadow:0 1px 2px rgba(0,0,0,.4),0 8px 22px -8px rgba(0,0,0,.6);
  --blend:screen; color-scheme:dark;
}
*{box-sizing:border-box}
html{scroll-padding-top:16px}
body{margin:0;background:var(--desk);color:var(--ink-1);font:400 16px/1.6 var(--text);display:grid;grid-template-columns:232px minmax(0,1fr);min-height:100vh;-webkit-font-smoothing:antialiased}
::selection{background:color-mix(in oklab,var(--kraft) 55%,transparent);color:var(--ink-1)}
:focus-visible{outline:2px solid var(--ink-1);outline-offset:2px;border-radius:2px}
*{scrollbar-width:thin;scrollbar-color:var(--rule-2) transparent}
code,kbd{font-family:var(--mono);font-size:.86em}
p code,li code,.lead code,.rest code{-webkit-box-decoration-break:clone;box-decoration-break:clone;background:var(--sheet-2);border:1px solid var(--rule);border-radius:3px;padding:0 .3em;color:var(--ink-1)}
a{color:inherit}
.muted{color:var(--ink-3)}
.field-label,.tag,.sp-tab,.sec-head,.ev-kind,.act,.ba-switch button,.sp-view button,.dk,.stamp,.sleeve-title,.sp-mark,.brief-by,.st-by{font-family:var(--cond);font-stretch:72%;text-transform:uppercase;letter-spacing:.07em}

/* the spine */
.spine{position:sticky;top:0;align-self:start;height:100vh;overflow:auto;background:var(--kraft);color:var(--kraft-ink);padding:18px 0 24px;border-right:1px solid var(--kraft-2);box-shadow:inset -8px 0 14px -10px rgba(0,0,0,.25)}
.diamond{color:var(--mark)}
.sp-mark .diamond{-webkit-text-stroke:.7px var(--kraft-ink);paint-order:stroke fill}
.sp-mark{padding:0 18px 14px;font-weight:800;font-size:15px;letter-spacing:.12em;color:var(--kraft-ink)}
.sp-view{display:flex;margin:0 12px 16px;border:1px solid var(--kraft-ink-2);border-radius:3px;overflow:hidden}
.sp-view button{flex:1;border:0;background:transparent;color:var(--kraft-ink);font-size:12.5px;font-weight:700;padding:6px 4px;cursor:pointer}
.sp-view button b{font-variant-numeric:tabular-nums}
.sp-view button[aria-checked="true"]{background:var(--kraft-ink);color:var(--kraft)}
.sp-group{margin:0 0 6px}
.sp-tab{display:flex;justify-content:space-between;align-items:baseline;margin-right:-1px;padding:6px 14px 5px 18px;font-weight:800;font-size:14px;text-decoration:none;color:var(--kraft-ink);background:color-mix(in oklab,var(--kraft-2) 70%,var(--kraft));border-radius:0 6px 6px 0;width:calc(100% - 14px)}
.sp-tab b{font-variant-numeric:tabular-nums;font-weight:700}
.sp-tab span{display:inline-flex;align-items:center;gap:7px}
.sp-p1 .sp-tab span::before,.sp-p2 .sp-tab span::before,.sp-p3 .sp-tab span::before{content:"";width:9px;height:9px;border-radius:2px;transform:rotate(-6deg)}
.sp-p1 .sp-tab span::before{background:var(--p1)} .sp-p2 .sp-tab span::before{background:var(--p2)} .sp-p3 .sp-tab span::before{background:var(--p3)}
.sp-group.empty .sp-tab{opacity:.55}
.spine ol{list-style:none;margin:4px 0 8px;padding:0}
.spine li a{display:grid;grid-template-columns:38px 1fr auto auto auto;align-items:center;gap:4px;padding:3px 12px 3px 18px;text-decoration:none;font-size:13px;line-height:1.35;color:var(--kraft-ink)}
.spine li a:hover{background:color-mix(in oklab,var(--kraft-ink) 8%,transparent)}
.spine li a.here{background:color-mix(in oklab,var(--kraft-ink) 14%,transparent)}
.spine li a.dim{opacity:.35}
.ix{font-family:var(--mono);font-size:11.5px;color:var(--kraft-ink-2)}
.sf{font-family:var(--mono);font-size:11.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spine svg{width:13px;height:13px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.sp-check,.sp-flag{display:none}
.spine li a.done .sp-check{display:inline-flex}
.spine li a.flagged .sp-flag{display:inline-flex;color:var(--mark)}
.sp-brief{display:inline-flex;color:var(--kraft-ink-2)}
.sp-progress{margin:18px 18px 0;padding-top:10px;border-top:1px solid var(--kraft-ink-2);font-size:12.5px;color:var(--kraft-ink-2);font-variant-numeric:tabular-nums}

/* the file */
.file{padding:28px clamp(16px,3vw,44px) 64px;max-width:1500px;width:100%}
.sheet,.exhibit{background:var(--sheet);box-shadow:var(--shadow);border-radius:2px}
.index{padding:22px 28px 6px;margin-bottom:26px;position:relative}
.ix-title{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:10px 24px;border-bottom:2px solid var(--ink-1);padding-bottom:14px}
h1{margin:0;font-family:var(--cond);font-stretch:68%;font-weight:800;font-size:clamp(34px,4.6vw,58px);line-height:.95;letter-spacing:-.01em;text-transform:uppercase}
.h-mark{display:none;font-size:.5em;vertical-align:.35em;margin-right:.3em}
.h-range{font-family:var(--mono);font-stretch:100%;font-weight:500;font-size:clamp(14px,.42em,24px);letter-spacing:0;text-transform:none;color:var(--ink-2);vertical-align:.4em}
.ix-docket{margin:0;display:flex;gap:16px;flex-wrap:wrap}
.dk{font-size:14px;font-weight:700;color:var(--ink-3)}
.dk b{font-family:var(--text);font-stretch:100%;font-size:22px;font-weight:800;color:var(--ink-1);margin-right:3px;font-variant-numeric:tabular-nums}
.dk-p1 b{color:var(--p1)} .dk-p2 b{color:var(--p2)} .dk-p3 b{color:var(--p3)} .dk.zero b{color:var(--ink-3)}
.ix-grid{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));column-gap:24px}
.ix-field{display:flex;flex-direction:column;gap:0;padding:7px 0 6px;border-bottom:1px solid var(--rule);min-width:0}
.ix-more{grid-column:1/-1}
.ix-more>summary{display:none}
.ix-field{grid-column:span 1} .ix-field.w2{grid-column:span 2} .ix-field.w3{grid-column:span 3} .ix-field.w4{grid-column:span 4} .ix-field.w6{grid-column:1/-1}
.ix-field.num .ix-value{font-size:18px;font-weight:700;font-variant-numeric:tabular-nums}
.ix-field.warn .ix-value{color:var(--p1)}
.ix-value{font-size:14.5px;overflow-wrap:anywhere}
.field-label{font-size:11.5px;font-weight:700;color:var(--ink-3)}
.sec-head{display:flex;align-items:baseline;gap:14px;margin:40px 0 14px;font-size:15px;font-weight:800;color:var(--ink-2)}
.sec-head small{font-family:var(--text);font-stretch:100%;text-transform:none;letter-spacing:0;font-weight:400;font-size:14px;color:var(--ink-3)}

/* an exhibit */
.exhibit{margin:0 0 12px;scroll-margin-top:12px}
.exhibit:target,.exhibit.here{box-shadow:var(--shadow),0 0 0 1.5px color-mix(in oklab,var(--ink) 50%,transparent)}
.ex-head{display:flex;align-items:center;flex-wrap:wrap;gap:6px 14px;margin:0 22px;padding:14px 0 12px;border-bottom:3px double var(--rule-2)}
.tag{display:inline-flex;align-items:center;gap:7px;font-weight:800;font-size:13px;padding:3px 10px 3px 7px;border:1px solid var(--ink-2);border-radius:3px 12px 12px 3px;background:var(--sheet);color:var(--ink-1)}
.hole{width:7px;height:7px;border-radius:50%;border:1.5px solid var(--ink-2);background:var(--sheet-2)}
.ex-loc{font-size:13.5px;font-weight:600;color:var(--ink-1)}
.ex-lens{font-size:13px;color:var(--ink-3)}
.ex-marks{margin-left:auto;display:flex;align-items:center;gap:12px}
.reviewed{display:none;align-items:center;gap:4px;font-family:var(--cond);font-stretch:72%;text-transform:uppercase;letter-spacing:.08em;font-weight:800;font-size:13px;color:var(--ink-2);border:2px solid var(--ink-2);border-radius:3px;padding:4px 9px 4px 6px;transform:rotate(2.5deg)}
.reviewed svg{width:15px;height:15px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round}
.exhibit.done .reviewed{display:inline-flex}
.exhibit.done.pressed .reviewed{animation:press .32s cubic-bezier(.16,1,.3,1)}
@keyframes press{from{transform:rotate(2.5deg) scale(1.5);opacity:0;filter:blur(2px)}to{transform:rotate(2.5deg) scale(1);opacity:1;filter:none}}
.stamp{display:inline-flex;flex-direction:column;align-items:center;color:var(--ink);border:3px double currentColor;border-radius:4px;padding:5px 12px 5px;transform:rotate(-2.5deg);mix-blend-mode:var(--blend);line-height:1}
.st-word{font-weight:800;letter-spacing:.14em}
.st-by{font-size:11px;font-weight:700;letter-spacing:.12em;margin-top:2px}
.st-P1 .st-word{font-size:25px} .st-P2 .st-word{font-size:20px} .st-P3 .st-word{font-size:16px} .st-none .st-word{font-size:14px}
.st-plausible,.st-undecided{border-style:dashed;border-width:2px}
.st-refuted,.st-dropped{color:var(--ink-3)}
.st-small{transform:rotate(-2deg) scale(.82);transform-origin:left center}
.ex-body{display:grid;grid-template-columns:minmax(300px,5fr) minmax(0,7fr);gap:0 30px;padding:20px 22px 22px}
.claim{max-width:68ch}
.lead{margin:0 0 10px;font-size:19px;line-height:1.45;font-weight:620;letter-spacing:-.005em;text-wrap:pretty}
.rest{margin:0 0 14px;color:var(--ink-2);text-wrap:pretty}
.field{margin:14px 0 0;padding-top:8px;border-top:1px solid var(--rule)}
.field-body{font-size:15px;color:var(--ink-2)}
.field-body p{margin:3px 0 0} .field-body ul{margin:4px 0 0;padding-left:18px}
.acts{display:flex;flex-wrap:wrap;gap:8px;margin-top:18px}
.act{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:700;color:var(--ink-1);background:var(--sheet);border:1px solid var(--rule-2);border-radius:3px;padding:6px 10px;cursor:pointer;text-decoration:none}
.act:hover{border-color:var(--ink-2)} .act:active{transform:translateY(1px)}
.act svg{width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:1.6;stroke-linecap:round;stroke-linejoin:round}
.act kbd{font-size:11px;color:var(--ink-3);border:1px solid var(--rule);border-radius:3px;padding:0 4px;text-transform:none}
.act.ok span{color:var(--add-ink)}
.exhibit.done .act-review{color:var(--ink-3)}
.proof{min-width:0;display:flex;flex-direction:column;gap:14px}

/* evidence */
.evidence{margin:0;border:1px solid var(--rule);border-radius:3px;background:var(--sheet);overflow:hidden}
.ev-head{display:flex;align-items:baseline;flex-wrap:wrap;gap:4px 10px;padding:6px 10px;border-bottom:1px solid var(--rule);background:var(--sheet-2);font-size:12.5px}
.ev-kind{font-weight:800;font-size:11.5px;color:var(--ink-3)}
.ev-head code{color:var(--ink-1)}
.ev-rev{color:var(--ink-3);margin-left:auto;font-size:12px}
.ev-caption{margin:0;padding:7px 12px 8px;border-top:1px solid var(--rule);font-size:13.5px;color:var(--ink-2)}
.code{overflow-x:auto;font:12.5px/1.6 var(--mono);font-variant-ligatures:none}
.code-inner{display:grid;width:max-content;min-width:100%;padding:6px 0}
.row{display:flex;align-items:baseline;padding-right:12px}
.no{flex:none;width:44px;padding-right:10px;text-align:right;color:var(--ink-3);opacity:.75;font-variant-numeric:tabular-nums;user-select:none}
.diff .no{width:38px}
.sign{flex:none;width:16px;color:var(--ink-3);user-select:none}
.src{white-space:pre;padding-left:4px}
.snippet .src{padding-left:14px}
.row.add{background:var(--add)} .row.add .sign{color:var(--add-ink);font-weight:700}
.row.del{background:var(--del)} .row.del .sign,.row.del .src,.row.del .src *{color:var(--del-ink)} .row.del .src{text-decoration:line-through;text-decoration-color:color-mix(in oklab,var(--del-ink) 45%,transparent)}
.row.fold .src{color:var(--ink-3);font-style:italic;font-family:var(--text)}
.row.mark{background:color-mix(in oklab,var(--ink) 16%,var(--sheet));box-shadow:inset 3px 0 0 var(--ink)}
.leader{flex:1 0 24px;align-self:center;border-bottom:1px dashed color-mix(in oklab,var(--ink) 70%,transparent);margin:0 6px 0 14px}
.pin{flex:none;position:sticky;right:8px;font:800 11px/1 var(--cond);font-stretch:72%;letter-spacing:.06em;color:var(--sheet);background:var(--ink);padding:3px 6px 2px;border-radius:2px;box-shadow:-10px 0 0 color-mix(in oklab,var(--ink) 16%,var(--sheet))}
.t-kw{color:var(--ink-1);font-weight:650} .t-str{color:var(--ink-2)} .t-num{color:var(--ink-1)} .t-com{color:var(--ink-3);font-style:italic} .t-type{color:var(--ink-1);font-weight:550}

/* diagrams */
.dg-wrap{overflow-x:auto;padding:14px 12px 8px}
.diagram{display:block;max-width:100%;height:auto;margin:0 auto;font-family:var(--mono)}
.dg-node rect{fill:var(--sheet);stroke:var(--ink-2);stroke-width:1.2}
.dg-label{font-size:12.5px;fill:var(--ink-1);font-weight:600}
.dg-note{font:400 11px var(--text);fill:var(--ink-3)}
.dg-accent rect{stroke:var(--ink);stroke-width:2;fill:color-mix(in oklab,var(--ink) 9%,var(--sheet))}
.dg-state rect{stroke-dasharray:4 3}
.dg-muted rect{stroke:var(--rule-2)} .dg-muted .dg-label{fill:var(--ink-3)}
.dg-edge{fill:none;stroke-width:1.4}
.dg-calls{stroke:var(--ink-3)} .dg-head.dg-calls{fill:none;stroke:var(--ink-3);stroke-width:1.4}
.dg-writes{stroke:var(--ink);stroke-dasharray:5 4;stroke-width:1.8} .dg-head.dg-writes{fill:none;stroke:var(--ink);stroke-dasharray:none;stroke-width:1.6}
.dg-reads{stroke:var(--ink-2);stroke-dasharray:1.5 3.5;stroke-linecap:round} .dg-head.dg-reads{fill:none;stroke:var(--ink-2);stroke-dasharray:none;stroke-width:1.4}
.dg-elabel{font-size:11px;fill:var(--ink-2);paint-order:stroke;stroke:var(--sheet);stroke-width:4px}
.dg-legend{margin-left:auto;display:inline-flex;align-items:center;gap:6px;font-size:11.5px;color:var(--ink-3)}
.dg-legend i{display:inline-block;width:20px;height:0;border-top:1.6px solid var(--ink-3);margin-left:6px}
.dg-legend .lg-writes{border-top:1.8px dashed var(--ink)} .dg-legend .lg-reads{border-top:2px dotted var(--ink-2)}

/* before / after */
.ba{display:flex;flex-direction:column;gap:12px}
.ba-switch{display:inline-flex;align-self:flex-start;border:1px solid var(--ink-2);border-radius:3px;overflow:hidden}
.ba-switch button{border:0;background:var(--sheet);color:var(--ink-1);font-size:13px;font-weight:800;padding:6px 12px;cursor:pointer}
.ba-switch button span{font-family:var(--mono);font-stretch:100%;text-transform:none;letter-spacing:0;font-weight:400;font-size:11.5px;color:var(--ink-3);margin-left:4px}
.ba-switch button[aria-selected="true"]{background:var(--ink-1);color:var(--sheet)}
.ba-switch button[aria-selected="true"] span{color:color-mix(in oklab,var(--sheet) 70%,transparent)}
.ba-pane{display:flex;flex-direction:column;gap:12px}
.ba-pane[hidden]{display:none}

/* a brief, clipped to its exhibit */
.brief{margin:0 22px 22px;padding:16px 20px 20px;background:var(--sheet-2);border:1px solid var(--rule-2);border-radius:2px;position:relative;display:flex;flex-direction:column;gap:14px}
.brief-head{display:flex;align-items:center;gap:12px}
.brief-head .clip{position:absolute;top:-12px;left:18px;color:var(--ink-2)}
.brief-head .clip svg{width:22px;height:22px;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round}
.brief-by{font-family:var(--text);font-stretch:100%;text-transform:none;letter-spacing:0;font-size:13px;color:var(--ink-3)}
.takeaway{margin:0;font-family:var(--cond);font-stretch:80%;font-size:clamp(22px,2.3vw,30px);font-weight:750;line-height:1.18;letter-spacing:-.005em;color:var(--ink-1);max-width:34ch;text-wrap:balance}
.prose{max-width:72ch;color:var(--ink-2)} .prose p{margin:0 0 10px} .prose p:last-child{margin:0} .prose strong{color:var(--ink-1)}

/* set aside */
.sleeve{margin-top:40px;padding:0;background:var(--sheet-2)}
.sleeve summary{display:flex;align-items:baseline;gap:14px;padding:14px 22px;cursor:pointer;list-style:none}
.sleeve summary::-webkit-details-marker{display:none}
.sleeve summary::before{content:"";width:8px;height:8px;border-right:2px solid var(--ink-2);border-bottom:2px solid var(--ink-2);transform:rotate(-45deg);align-self:center;transition:transform .2s}
.sleeve[open] summary::before{transform:rotate(45deg)}
.sleeve-title{font-weight:800;font-size:15px}
.aside{list-style:none;margin:0;padding:0 22px 12px}
.aside-row{padding:12px 0;border-top:1px solid var(--rule)}
.aside-top{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px}
.aside-top code{font-size:13px}
.aside-claim{margin:6px 0 4px;max-width:80ch}
.aside-why{margin:0;max-width:80ch;color:var(--ink-2);font-size:14.5px}
.aside-why .field-label{margin-right:6px}
.colophon{margin-top:28px;font-size:13px;color:var(--ink-3)}

/* views */
body.view-thought .exhibit:not(.thought){display:none}
body.view-thought .spine li a[data-thought="false"]{display:none}

@media (max-width:1180px){.ex-body{grid-template-columns:minmax(0,1fr)}.claim{max-width:none}.proof{margin-top:16px}}
@media (max-width:820px){
  html{scroll-padding-top:72px} .exhibit{scroll-margin-top:72px}
  body{grid-template-columns:minmax(0,1fr)}
  .spine{position:sticky;top:0;z-index:5;height:auto;display:flex;align-items:center;gap:8px;padding:8px 12px;overflow-x:auto;border-right:0;border-bottom:1px solid var(--kraft-2);box-shadow:0 4px 10px -6px rgba(0,0,0,.3)}
  .sp-mark,.spine ol,.sp-progress{display:none}
  .sp-view{margin:0;flex:none}
  .sp-group{margin:0;flex:none}
  .sp-tab{width:auto;border-radius:4px;gap:6px;padding:5px 9px}
  .file{padding:16px 16px 48px}
  .index{padding:18px 16px 6px}
  .ix-grid{grid-template-columns:repeat(3,minmax(0,1fr));column-gap:14px}
  .ix-more>summary{display:flex;align-items:center;gap:10px;padding:9px 0;cursor:pointer;border-bottom:1px solid var(--rule);list-style:none}
  .ix-more>summary::-webkit-details-marker{display:none}
  .ix-more>summary::before{content:"";width:7px;height:7px;border-right:2px solid var(--ink-3);border-bottom:2px solid var(--ink-3);transform:rotate(-45deg);transition:transform .2s}
  .ix-more[open]>summary::before{transform:rotate(45deg)}
  .ix-docket{display:grid;grid-template-columns:repeat(5,auto);gap:4px 12px;width:100%}
  .dk{display:flex;flex-direction:column;font-size:11.5px}
  .dk b{font-size:20px}
  .h-mark{display:inline}
  .ix-field.w2,.ix-field.w3,.ix-field.w4,.ix-field.w6{grid-column:1/-1}
  .ex-head{margin:0 14px;padding:10px 0}
  .ex-marks{margin-left:0;width:100%;justify-content:flex-end}
  .ex-body{padding:14px 14px 16px}
  .brief{margin:0 12px 14px;padding:14px}
  .lead{font-size:17.5px}
}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`

const JS = String.raw`
(() => {
  const run = document.body.dataset.run
  const store = (() => { try { return JSON.parse(localStorage.getItem("dossier:" + run) || "{}") } catch { return {} } })()
  const save = () => { try { localStorage.setItem("dossier:" + run, JSON.stringify(store)) } catch {} }
  store.done = store.done || []
  const exhibits = [...document.querySelectorAll(".exhibit")]
  const link = (no) => document.querySelector('.spine a[data-for="' + no + '"]')
  const paint = () => {
    for (const ex of exhibits) {
      const done = store.done.includes(ex.dataset.no)
      ex.classList.toggle("done", done)
      const a = link(ex.dataset.no)
      if (a) { a.classList.toggle("done", done); a.classList.toggle("flagged", store.flag === ex.dataset.no) }
    }
    const p = document.querySelector("[data-progress]")
    if (p) p.textContent = String(store.done.length)
  }
  const visible = () => exhibits.filter((ex) => ex.offsetParent !== null)
  let current = null
  const focus = (ex) => {
    if (!ex) return
    current = ex
    ex.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" })
    ex.focus({ preventScroll: true })
  }
  const review = (ex) => {
    if (!ex) return
    const no = ex.dataset.no
    if (store.done.includes(no)) store.done = store.done.filter((x) => x !== no)
    else { store.done.push(no); ex.classList.add("pressed"); setTimeout(() => ex.classList.remove("pressed"), 400) }
    store.flag = no
    save(); paint()
  }
  document.addEventListener("click", (e) => {
    const t = e.target.closest("button")
    if (!t) return
    if (t.hasAttribute("data-review")) review(t.closest(".exhibit"))
    if (t.dataset.copy) {
      navigator.clipboard?.writeText(t.dataset.copy).then(() => {
        const label = t.querySelector("span"); const was = label.textContent
        label.textContent = t.dataset.done; t.classList.add("ok")
        setTimeout(() => { label.textContent = was; t.classList.remove("ok") }, 1400)
      })
    }
    if (t.dataset.side) {
      const ba = t.closest(".ba")
      for (const b of ba.querySelectorAll(".ba-switch button")) b.setAttribute("aria-selected", String(b === t))
      for (const p of ba.querySelectorAll(":scope > .ba-pane")) p.hidden = p.dataset.pane !== t.dataset.side
    }
    if (t.dataset.view) {
      for (const b of document.querySelectorAll(".sp-view button")) b.setAttribute("aria-checked", String(b === t))
      document.body.classList.toggle("view-thought", t.dataset.view === "thought")
    }
  })
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /INPUT|TEXTAREA/.test(document.activeElement?.tagName || "")) return
    const list = visible()
    const at = list.indexOf(current ?? list[0])
    if (e.key === "j") focus(list[Math.min(list.length - 1, current ? at + 1 : 0)])
    else if (e.key === "k") focus(list[Math.max(0, at - 1)])
    else if (e.key === "x") review(current ?? list[0])
    else return
    e.preventDefault()
  })
  // The spine follows the exhibit in view.
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue
      current = en.target
      document.querySelectorAll(".spine a.here").forEach((a) => a.classList.remove("here"))
      link(en.target.dataset.no)?.classList.add("here")
    }
  }, { rootMargin: "-20% 0px -70% 0px" })
  exhibits.forEach((ex) => io.observe(ex))
  if (matchMedia("(max-width: 820px)").matches) document.querySelectorAll(".ix-more").forEach((d) => { d.open = false })
  if (store.flag && !location.hash) setTimeout(() => focus(document.getElementById(store.flag)), 60)
  paint()
})()
`

const [runDir, out, briefs] = process.argv.slice(2)
if (runDir === undefined || out === undefined) {
  console.error("usage: bun render.ts <run-dir> <out.html> [briefs.json]")
  process.exit(2)
}
writeFileSync(out, render(runDir, briefs))
console.log(`wrote ${out}`)
