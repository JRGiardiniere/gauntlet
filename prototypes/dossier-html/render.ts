// Prototype: a deterministic, zero-token HTML companion to dossier.md.
//
//   bun render.ts <run-dir> <out.html>
//
// Reads dossier.json (the Dossier), takes the header facts the Run already
// rendered into dossier.md (accounting is not in dossier.json), and pulls
// evidence from git in target.repoRoot: an excerpt of the file at headCommit
// around each finding's line, and the diff hunk of base..head covering it.
// Output is one self-contained HTML file. No clock, no randomness, no network:
// the same run directory and repository always render the same bytes.
import { spawnSync } from "node:child_process"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"

// ---------------------------------------------------------------------------
// Dossier shape (the slice of src/domain/dossier.ts this view reads)

type Priority = "P1" | "P2" | "P3"
interface Candidate {
  _tag: "BugClaim" | "Observation"
  id: string
  lens: string
  file: string
  line?: number
  summary: string
  sourceReferences?: ReadonlyArray<string>
  failureScenario?: string
}
interface TestSuggestion { tests: ReadonlyArray<string>; reason: string }
interface Dossier {
  runId: string
  target: { _tag: string; repoRoot: string; baseCommit?: string; headCommit: string; number?: number }
  findings: ReadonlyArray<any>
  unresolved: ReadonlyArray<any>
  rejected: { refutedClaims: ReadonlyArray<any>; droppedObservations: ReadonlyArray<any> }
  coverageGaps: ReadonlyArray<{ stage: string; lens?: string; reason: string }>
}

// Mirrors src/render/dossier-view.ts: one entry per finding, cluster-mates
// folded into the fullest claim, every contributing Lens credited.
type EntryTag = "confirmed" | "judgment" | "plausible" | "undecided" | "refuted" | "dropped"
interface Entry {
  candidate: Candidate
  lenses: ReadonlyArray<string>
  tag: EntryTag
  priority?: Priority
  detail?: string
  testSuggestion?: TestSuggestion
  mates: ReadonlyArray<Candidate>
  merged: ReadonlyArray<string>
}

const substance = (c: Candidate) => c.summary.length + (c.failureScenario?.length ?? 0)
const claimEntry = (e: any, tag: EntryTag, priority: Priority | undefined, detail: string | undefined): Entry => {
  const claims: Array<Candidate> = e.bugClaims
  const fullest = claims.slice(1).reduce((a, c) => (substance(c) > substance(a) ? c : a), claims[0]!)
  return {
    candidate: fullest,
    lenses: [...new Set(claims.map((c) => c.lens))],
    tag,
    priority,
    detail,
    testSuggestion: e.testSuggestion,
    mates: claims.filter((c) => c !== fullest),
    merged: [],
  }
}
const observationEntry = (e: any, tag: EntryTag): Entry => ({
  candidate: e.candidate,
  lenses: [e.candidate.lens],
  tag,
  priority: e.judgment.reviewPriority,
  detail: e.judgment.reason,
  mates: [],
  merged: e.judgment.mergedCandidateIds ?? [],
})

const viewDossier = (d: Dossier) => ({
  findings: d.findings.map((e) =>
    e._tag === "Confirmed"
      ? claimEntry(e, "confirmed", e.verdict.reviewPriority, e.verdict.evidence)
      : observationEntry(e, "judgment")
  ),
  unresolved: d.unresolved.map((e) =>
    e._tag === "Plausible"
      ? claimEntry(e, "plausible", e.verdict.reviewPriority, e.verdict.evidence)
      : observationEntry(e, "undecided")
  ),
  refuted: d.rejected.refutedClaims.map((e) => claimEntry(e, "refuted", undefined, e.verdict.evidence)),
  dropped: d.rejected.droppedObservations.map((e) => observationEntry(e, "dropped")),
})

// ---------------------------------------------------------------------------
// Header facts. dossier.md is the only place the Run's accounting lands, so
// the prototype reads its "- Key: value" header lines and run notes back.

interface HeaderFacts {
  recipe?: string
  lenses: Array<{ name: string; seat: string }>
  cost?: string
  invocations?: string
  wallSeconds?: number
  warnings?: string
  skipped: Array<{ name: string; reason: string }>
  runNotes: Array<string>
}

const readHeaderFacts = (runDir: string): HeaderFacts => {
  const facts: HeaderFacts = { lenses: [], skipped: [], runNotes: [] }
  const mdPath = join(runDir, "dossier.md")
  if (!existsSync(mdPath)) return facts
  const md = readFileSync(mdPath, "utf8")
  const head = md.split("\n## Findings")[0] ?? ""
  let inNotes = false
  for (const line of head.split("\n")) {
    if (line.startsWith("## Run notes")) inNotes = true
    if (inNotes) {
      if (line.startsWith("- ")) facts.runNotes.push(line.slice(2))
      continue
    }
    const m = /^- ([A-Za-z ]+): (.*)$/.exec(line)
    if (m === null) continue
    const [, key, value] = m as unknown as [string, string, string]
    if (key === "Recipe") facts.recipe = value
    if (key === "Lenses" && value !== "none") {
      facts.lenses = value.split(/, (?![^(]*\))/).map((part) => {
        const lm = /^(.*?) \((.*)\)$/.exec(part)
        return lm === null ? { name: part, seat: "" } : { name: lm[1]!, seat: lm[2]! }
      })
    }
    if (key === "Cost") {
      const cm = /^(\$[\d.]+) · (\d+) invocations · (\d+)s$/.exec(value)
      if (cm !== null) {
        facts.cost = cm[1]
        facts.invocations = cm[2]
        facts.wallSeconds = Number(cm[3])
      }
    }
    if (key === "Warnings" && value !== "none") facts.warnings = value
    if (key === "Skipped") {
      facts.skipped = value.split("; ").map((s) => {
        const [name, ...rest] = s.split(" — ")
        return { name: name!, reason: rest.join(" — ") }
      })
    }
  }
  return facts
}

// ---------------------------------------------------------------------------
// Git evidence

const git = (repo: string, args: Array<string>): string | undefined => {
  const r = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })
  return r.status === 0 ? r.stdout : undefined
}

interface DiffRow { kind: "ctx" | "add" | "del"; oldNo?: number; newNo?: number; text: string }
interface Hunk { header: string; newStart: number; newLen: number; oldStart: number; oldLen: number; rows: Array<DiffRow> }

const parseHunks = (diff: string): Array<Hunk> => {
  const hunks: Array<Hunk> = []
  let cur: Hunk | undefined
  let o = 0
  let n = 0
  for (const line of diff.split("\n")) {
    const h = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/.exec(line)
    if (h !== null) {
      o = Number(h[1])
      n = Number(h[3])
      cur = {
        header: line,
        oldStart: o,
        oldLen: h[2] === undefined ? 1 : Number(h[2]),
        newStart: n,
        newLen: h[4] === undefined ? 1 : Number(h[4]),
        rows: [],
      }
      hunks.push(cur)
      continue
    }
    if (cur === undefined || line.startsWith("\\")) continue
    if (line.startsWith("+")) cur.rows.push({ kind: "add", newNo: n++, text: line.slice(1) })
    else if (line.startsWith("-")) cur.rows.push({ kind: "del", oldNo: o++, text: line.slice(1) })
    else if (line.startsWith(" ")) cur.rows.push({ kind: "ctx", oldNo: o++, newNo: n++, text: line.slice(1) })
  }
  return hunks
}

class Repo {
  private files = new Map<string, Array<string> | undefined>()
  private diffs = new Map<string, Array<Hunk>>()
  readonly tree: Array<string>
  constructor(readonly root: string, readonly base: string | undefined, readonly head: string) {
    this.tree = (git(root, ["ls-tree", "-r", "--name-only", head]) ?? "").split("\n").filter(Boolean)
  }
  lines(file: string, rev = this.head): Array<string> | undefined {
    const key = `${rev}:${file}`
    if (!this.files.has(key)) {
      const text = git(this.root, ["show", key])
      this.files.set(key, text?.replace(/\n$/, "").split("\n"))
    }
    return this.files.get(key)
  }
  hunks(file: string): Array<Hunk> {
    if (this.base === undefined) return []
    if (!this.diffs.has(file)) {
      this.diffs.set(file, parseHunks(git(this.root, ["diff", "--no-color", "-U3", this.base, this.head, "--", file]) ?? ""))
    }
    return this.diffs.get(file)!
  }
  // A basename cited in model prose ("engine.ts:349") resolved to one tracked
  // path, preferring the finding's own directory when the name is ambiguous.
  resolve(name: string, near: string): string | undefined {
    if (this.tree.includes(name)) return name
    const hits = this.tree.filter((p) => p === name || p.endsWith(`/${name}`))
    if (hits.length === 1) return hits[0]
    const dir = near.includes("/") ? near.slice(0, near.lastIndexOf("/") + 1) : ""
    const local = hits.filter((p) => p.startsWith(dir))
    return local.length === 1 ? local[0] : undefined
  }
}

// ---------------------------------------------------------------------------
// Tiny highlighter: comments, strings, numbers/hex colors, keywords, types.

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

const KEYWORDS = new Set(
  "import export from const let var function return if else for while do of in new type interface extends implements class readonly as async await yield throw try catch finally switch case default break continue typeof keyof void undefined null true false this satisfies declare namespace enum".split(" "),
)
const TOKEN = /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(#[0-9a-fA-F]{3,8}\b|\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g

const highlighter = (file: string) => {
  const code = /\.(m?[jt]sx?|json|cjs|mts)$/.test(file)
  let inBlock = false
  return (line: string): string => {
    if (!code) return esc(line)
    let out = ""
    let rest = line
    if (inBlock) {
      const end = rest.indexOf("*/")
      if (end === -1) return `<span class="t-com">${esc(rest)}</span>`
      out += `<span class="t-com">${esc(rest.slice(0, end + 2))}</span>`
      rest = rest.slice(end + 2)
      inBlock = false
    }
    let last = 0
    for (const m of rest.matchAll(TOKEN)) {
      out += esc(rest.slice(last, m.index))
      last = m.index! + m[0].length
      const [t, lineCom, blockCom, str, num, word] = m
      if (lineCom !== undefined) out += `<span class="t-com">${esc(t)}</span>`
      else if (blockCom !== undefined) {
        if (!t.endsWith("*/")) inBlock = true
        out += `<span class="t-com">${esc(t)}</span>`
      } else if (str !== undefined) out += `<span class="t-str">${esc(t)}</span>`
      else if (num !== undefined) out += `<span class="t-num">${esc(t)}</span>`
      else if (word !== undefined && KEYWORDS.has(word)) out += `<span class="t-kw">${t}</span>`
      else if (word !== undefined && /^[A-Z]/.test(word)) out += `<span class="t-type">${t}</span>`
      else out += esc(t)
    }
    return out + esc(rest.slice(last))
  }
}

// ---------------------------------------------------------------------------
// Evidence panes

const CONTEXT = 6

const excerptPane = (repo: Repo, file: string, from: number, to: number, mark: Set<number>, rev: string) => {
  const lines = repo.lines(file, rev)
  if (lines === undefined) return undefined
  const start = Math.max(1, from - CONTEXT)
  const end = Math.min(lines.length, to + CONTEXT)
  if (start > lines.length) return undefined
  const hl = highlighter(file)
  // Prime the block-comment state with the lines above the window.
  for (let i = Math.max(0, start - 40); i < start - 1; i++) hl(lines[i]!)
  const rows: Array<string> = []
  for (let no = start; no <= end; no++) {
    rows.push(
      `<div class="row${mark.has(no) ? " mark" : ""}"><span class="no">${no}</span><span class="src">${hl(lines[no - 1]!) || " "}</span></div>`,
    )
  }
  return `<div class="code"><div class="code-inner">${rows.join("")}</div></div>`
}

interface DiffPane { html: string; lineAdded: boolean }

const diffPane = (repo: Repo, file: string, line: number): DiffPane | undefined => {
  const hunk = repo.hunks(file).find((h) => line >= h.newStart && line < h.newStart + Math.max(h.newLen, 1))
  if (hunk === undefined) return undefined
  let at = hunk.rows.findIndex((r) => r.newNo === line)
  if (at === -1) at = 0
  const WINDOW = 9
  const lo = hunk.rows.length <= WINDOW * 2 + 6 ? 0 : Math.max(0, at - WINDOW)
  const hi = hunk.rows.length <= WINDOW * 2 + 6 ? hunk.rows.length : Math.min(hunk.rows.length, at + WINDOW + 1)
  const hl = highlighter(file)
  const sign = { ctx: " ", add: "+", del: "−" } as const
  const rows: Array<string> = []
  const fold = (n: number) => `<div class="row fold"><span class="no"></span><span class="no"></span><span class="sign"></span><span class="src">⋯ ${n} more line${n === 1 ? "" : "s"} in this hunk</span></div>`
  rows.push(`<div class="row hunk"><span class="src">${esc(hunk.header)}</span></div>`)
  if (lo > 0) rows.push(fold(lo))
  for (const r of hunk.rows.slice(lo, hi)) {
    rows.push(
      `<div class="row ${r.kind}${r.newNo === line ? " mark" : ""}"><span class="no">${r.oldNo ?? ""}</span><span class="no">${r.newNo ?? ""}</span><span class="sign">${sign[r.kind]}</span><span class="src">${hl(r.text) || " "}</span></div>`,
    )
  }
  if (hi < hunk.rows.length) rows.push(fold(hunk.rows.length - hi))
  return {
    html: `<div class="code diff"><div class="code-inner">${rows.join("")}</div></div>`,
    lineAdded: hunk.rows[at]?.kind === "add",
  }
}

// `file.ts:12` or `file.ts:12-18` cited in a reason or failure scenario.
const CITATION = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.(?:ts|tsx|js|json|md)):(\d+)(?:[-–](\d+))?/g

interface Tab { id: string; label: string; html: string; note?: string }

const evidenceTabs = (repo: Repo, entry: Entry, texts: Array<string>): { tabs: Array<Tab>; initial: string; badge: string } => {
  const c = entry.candidate
  const tabs: Array<Tab> = []
  let badge = ""
  let initial = "code"
  if (c.line !== undefined) {
    const atHead = excerptPane(repo, c.file, c.line, c.line, new Set([c.line]), repo.head)
    const fallback = atHead ?? (repo.base === undefined ? undefined : excerptPane(repo, c.file, c.line, c.line, new Set([c.line]), repo.base))
    if (fallback !== undefined) {
      tabs.push({
        id: "code",
        label: `${basename(c.file)}<span class="at">@${(atHead ? repo.head : repo.base!).slice(0, 7)}</span>`,
        html: fallback,
      })
    }
    const diff = diffPane(repo, c.file, c.line)
    if (diff !== undefined) {
      tabs.push({ id: "diff", label: "Diff", html: diff.html })
      badge = diff.lineAdded ? "line added in this range" : "inside a changed hunk"
      if (diff.lineAdded) initial = "diff"
    } else badge = repo.hunks(c.file).length > 0 ? "line unchanged in this range" : "file unchanged in this range"
  } else {
    const first = repo.hunks(c.file)[0]
    if (first !== undefined) {
      const d = diffPane(repo, c.file, first.newStart)
      if (d !== undefined) tabs.push({ id: "diff", label: "Diff", html: d.html })
      initial = "diff"
    }
    badge = "whole-file finding"
  }
  // Citations in the evaluator's prose, resolved against the head tree.
  const seen = new Set<string>()
  for (const text of texts) {
    for (const m of text.matchAll(CITATION)) {
      const path = repo.resolve(m[1]!, c.file)
      if (path === undefined) continue
      const from = Number(m[2])
      const to = m[3] === undefined ? from : Number(m[3])
      if (path === c.file && c.line !== undefined && Math.abs(from - c.line) <= CONTEXT && to - c.line <= CONTEXT) continue
      const key = `${path}:${from}`
      if (seen.has(key) || seen.size >= 4) continue
      seen.add(key)
      const marks = new Set<number>()
      for (let i = from; i <= Math.min(to, from + 30); i++) marks.add(i)
      const pane = excerptPane(repo, path, from, Math.min(to, from + 30), marks, repo.head)
      if (pane !== undefined) {
        tabs.push({ id: `ref${seen.size}`, label: `${esc(basename(path))}:${from}${m[3] ? `–${to}` : ""}`, html: pane, note: "cited" })
      }
    }
  }
  if (!tabs.some((t) => t.id === initial)) initial = tabs[0]?.id ?? ""
  return { tabs, initial, badge }
}

// ---------------------------------------------------------------------------
// Card markup

const inline = (text: string) =>
  esc(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")

const TAG_TITLE: Record<EntryTag, string> = {
  confirmed: "BugClaim confirmed by Verification",
  judgment: "Observation kept by Judgment",
  plausible: "BugClaim Verification could neither confirm nor refute",
  undecided: "Observation Judgment said nothing about",
  refuted: "BugClaim refuted by Verification",
  dropped: "Observation dropped by Judgment",
}
const DETAIL_LABEL: Record<EntryTag, string> = {
  confirmed: "Verification",
  judgment: "Judgment",
  plausible: "Verification",
  undecided: "Judgment",
  refuted: "Verification",
  dropped: "Judgment",
}

const location = (c: Candidate) => (c.line === undefined ? c.file : `${c.file}:${c.line}`)

const card = (repo: Repo, entry: Entry, index: number) => {
  const c = entry.candidate
  const pr = entry.priority ?? "none"
  const scenario = c.failureScenario
  const texts = [entry.detail ?? "", scenario ?? ""]
  const ev = evidenceTabs(repo, entry, texts)
  const lensChips = entry.lenses.map((l) => `<span class="lens">${esc(l)}</span>`).join("")
  const support = entry.detail ?? scenario
  const supportLabel = entry.detail === undefined ? "Failure scenario" : DETAIL_LABEL[entry.tag]
  const extras: Array<string> = []
  if (entry.detail !== undefined && scenario !== undefined) {
    extras.push(`<details class="more"><summary>Failure scenario</summary><p>${inline(scenario)}</p></details>`)
  }
  if (entry.mates.length > 0) {
    extras.push(
      `<details class="more"><summary>${entry.mates.length} duplicate claim${entry.mates.length === 1 ? "" : "s"} in this cluster</summary><ul>${
        entry.mates.map((m) => `<li><span class="lens">${esc(m.lens)}</span> <code>${esc(location(m))}</code> ${inline(m.summary)}</li>`).join("")
      }</ul></details>`,
    )
  }
  if (entry.merged.length > 0) {
    extras.push(`<p class="meta-line">Merged with ${entry.merged.map((id) => `<code>${esc(id)}</code>`).join(", ")}</p>`)
  }
  const tests = entry.testSuggestion === undefined ? "" : `<div class="tests"><span class="tests-label">Suggested tests</span><span>${
    entry.testSuggestion.tests.map((t) => `<code>${esc(t)}</code>`).join(" ")
  } — ${inline(entry.testSuggestion.reason)}</span></div>`
  const evidence = ev.tabs.length === 0 ? "" : `<section class="evidence" data-initial="${ev.initial}">
      <div class="ev-bar" role="tablist">${
    ev.tabs.map((t) => `<button type="button" role="tab" class="ev-tab${t.note ? " cited" : ""}" data-tab="${t.id}" aria-selected="${t.id === ev.initial}">${t.label}</button>`).join("")
  }<span class="ev-badge">${esc(ev.badge)}</span></div>${
    ev.tabs.map((t) => `<div class="ev-pane" data-pane="${t.id}"${t.id === ev.initial ? "" : " hidden"}>${t.html}</div>`).join("")
  }</section>`
  return `<article class="card" id="f${index}" data-key="${esc(c.id)}" data-priority="${pr}" data-lenses="${esc(entry.lenses.join(" "))}" tabindex="-1">
    <header class="card-head">
      <span class="pill pr-${pr}">${entry.priority ?? "—"}</span>
      <span class="tag tag-${entry.tag}" title="${TAG_TITLE[entry.tag]}">${entry.tag}</span>
      ${lensChips}
      <button type="button" class="loc" title="Copy location">${esc(location(c))}</button>
      <button type="button" class="done" title="Mark reviewed (x)" aria-pressed="false">✓</button>
    </header>
    <h3 class="claim">${inline(c.summary)}</h3>
    ${support === undefined ? "" : `<p class="support"><span class="support-label">${supportLabel}</span>${inline(support)}</p>`}
    ${extras.join("\n")}
    ${tests}
    ${evidence}
  </article>`
}

// ---------------------------------------------------------------------------
// Page

const shortSha = (s: string) => s.slice(0, 7)
const duration = (s: number) => (s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`)

const render = (runDir: string): string => {
  const dossier: Dossier = JSON.parse(readFileSync(join(runDir, "dossier.json"), "utf8"))
  const facts = readHeaderFacts(runDir)
  const t = dossier.target
  const repo = new Repo(t.repoRoot, t.baseCommit, t.headCommit)
  const view = viewDossier(dossier)
  const rank = (p?: Priority) => (p === undefined ? 9 : Number(p[1]))
  // Assembly already orders by Review Priority then path; a stable sort keeps
  // that order and guards the priority grouping.
  const findings = [...view.findings].sort((a, b) => rank(a.priority) - rank(b.priority))

  let n = 0
  const cards = (entries: ReadonlyArray<Entry>) => entries.map((e) => card(repo, e, n++)).join("\n")

  const counts = { P1: 0, P2: 0, P3: 0, none: 0 }
  for (const f of findings) counts[f.priority ?? "none"]++
  const total = findings.length
  const bar = total === 0
    ? `<div class="bar"><span class="seg pr-clean" style="flex:1"></span></div>`
    : `<div class="bar">${(["P1", "P2", "P3", "none"] as const).filter((p) => counts[p] > 0)
      .map((p) => `<span class="seg pr-${p}" style="flex:${counts[p]}" title="${p === "none" ? "unranked" : p}: ${counts[p]}"></span>`).join("")}</div>`

  const lensesInFindings = [...new Set([...findings, ...view.unresolved].flatMap((f) => f.lenses))].sort()
  const chip = (kind: string, value: string, label: string, count?: number) =>
    `<button type="button" class="chip" data-kind="${kind}" data-value="${esc(value)}" aria-pressed="false">${label}${count === undefined ? "" : `<span class="count">${count}</span>`}</button>`
  const priorityChips = (["P1", "P2", "P3"] as const)
    .map((p) => chip("priority", p, `<span class="dot pr-${p}"></span>${p}`, counts[p])).join("")
  const lensChips = lensesInFindings.map((l) => chip("lens", l, esc(l))).join("")

  const targetLine = t._tag === "PullRequest"
    ? `PR #${t.number} <span class="sha">head ${shortSha(t.headCommit)}</span>`
    : t.baseCommit === undefined
    ? `working tree <span class="sha">HEAD ${shortSha(t.headCommit)}</span>`
    : `<span class="sha" title="${t.baseCommit}">${shortSha(t.baseCommit)}</span><span class="range">..</span><span class="sha" title="${t.headCommit}">${shortSha(t.headCommit)}</span>`
  const targetKind = { Commits: "commits", WorkingTree: "working tree", PullRequest: "pull request" }[t._tag] ?? t._tag

  const recipeName = facts.recipe?.split(" (")[0] ?? "none"
  const seats = facts.recipe?.match(/\((.*)\)$/)?.[1] ?? ""
  const uniqueSeats = [...new Set(facts.lenses.map((l) => l.seat))]

  const gaps = dossier.coverageGaps.length === 0
    ? `<span class="ok">none</span>`
    : dossier.coverageGaps.map((g) => `<span class="warn">${esc(g.stage)}${g.lens ? ` (${esc(g.lens)})` : ""}: ${inline(g.reason)}</span>`).join("<br>")

  const section = (id: string, title: string, entries: ReadonlyArray<Entry>, blurb: string) =>
    entries.length === 0 ? "" : `<details class="group" id="${id}">
      <summary><span class="group-title">${title}</span><span class="count">${entries.length}</span><span class="group-blurb">${blurb}</span></summary>
      <div class="cards">${cards(entries)}</div>
    </details>`

  const findingsHtml = cards(findings)
  const unresolvedHtml = section("unresolved", "Unresolved", view.unresolved, "plausible claims and undecided observations")
  const refutedHtml = section("refuted", "Refuted claims", view.refuted, "Verification refuted the failure scenario")
  const droppedHtml = section("dropped", "Dropped observations", view.dropped, "Judgment dropped them with a reason")

  const repoName = basename(t.repoRoot)
  const title = `Gauntlet review ${shortSha(t.headCommit)}`

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
  <header class="mast">
    <div class="eyebrow">Gauntlet review · <span class="mono">${esc(dossier.runId)}</span></div>
    <h1><span class="kind">${targetKind}</span> ${targetLine} <span class="repo">${esc(repoName)}</span></h1>
    <div class="stats">
      ${facts.cost === undefined ? "" : `<div class="stat"><span class="v">${facts.cost}</span><span class="k">cost</span></div>`}
      ${facts.invocations === undefined ? "" : `<div class="stat"><span class="v">${facts.invocations}</span><span class="k">invocations</span></div>`}
      ${facts.wallSeconds === undefined ? "" : `<div class="stat"><span class="v">${duration(facts.wallSeconds)}</span><span class="k">wall time</span></div>`}
      <div class="stat"><span class="v">${facts.lenses.length || "—"}</span><span class="k">lenses run</span></div>
    </div>
    <dl class="facts">
      <dt>Recipe</dt><dd><strong>${esc(recipeName)}</strong> <span class="muted mono small">${esc(seats)}</span></dd>
      <dt>Lenses</dt><dd>${facts.lenses.map((l) => `<span class="lens">${esc(l.name)}</span>`).join(" ")}${
    uniqueSeats.length === 1 ? ` <span class="muted mono small">all on ${esc(uniqueSeats[0]!)}</span>` : ""
  }</dd>
      ${facts.skipped.length === 0 ? "" : `<dt>Skipped</dt><dd>${facts.skipped.map((s) => `<span class="lens off">${esc(s.name)}</span> <span class="muted">${esc(s.reason)}</span>`).join("; ")}</dd>`}
      <dt>Coverage gaps</dt><dd>${gaps}</dd>
      ${facts.warnings === undefined ? "" : `<dt>Warnings</dt><dd class="warn">${inline(facts.warnings)}</dd>`}
      ${facts.runNotes.length === 0 ? "" : `<dt>Run notes</dt><dd class="muted">${facts.runNotes.map(inline).join("<br>")}</dd>`}
    </dl>
  </header>

  <section class="summary">
    <div class="summary-top">
      <h2>${total === 0 ? "No findings" : `${total} finding${total === 1 ? "" : "s"}`}</h2>
      <div class="tally">
        ${(["P1", "P2", "P3"] as const).map((p) => `<span class="t"><span class="dot pr-${p}"></span>${p} <b>${counts[p]}</b></span>`).join("")}
        ${counts.none > 0 ? `<span class="t"><span class="dot pr-none"></span>unranked <b>${counts.none}</b></span>` : ""}
      </div>
    </div>
    ${bar}
    <div class="aside">
      ${view.unresolved.length ? `<a href="#unresolved">${view.unresolved.length} unresolved</a>` : ""}
      ${view.refuted.length ? `<a href="#refuted">${view.refuted.length} refuted</a>` : ""}
      ${view.dropped.length ? `<a href="#dropped">${view.dropped.length} dropped</a>` : ""}
      <span class="progress" id="progress"></span>
    </div>
  </section>

  <nav class="filters" aria-label="Filter findings">
    <div class="chips">${priorityChips}<span class="sep"></span>${lensChips}</div>
    <span class="shown" id="shown"></span>
  </nav>

  <main class="cards" id="findings">
    ${total === 0 ? `<p class="clean"><span class="dot pr-clean"></span>Nothing survived evaluation.</p>` : findingsHtml}
  </main>

  ${unresolvedHtml}
  ${refutedHtml}
  ${droppedHtml}

  <footer class="foot">
    <span><kbd>j</kbd>/<kbd>k</kbd> move</span><span><kbd>d</kbd> next evidence</span><span><kbd>x</kbd> reviewed</span><span><kbd>c</kbd> copy location</span>
    <span class="muted">Rendered from dossier.json and git at ${shortSha(t.headCommit)}; no model calls.</span>
  </footer>
</div>
<script>const RUN_ID = ${JSON.stringify(dossier.runId)};${JS}</script>
</body>
</html>
`
}

// ---------------------------------------------------------------------------

const CSS = String.raw`
:root{
  --p1:#e5484d;--p2:#ff8700;--p3:#e0b000;--pn:#8b8b8b;--clean:#30a46c;
  --bg:#f7f7f5;--surface:#ffffff;--sunken:#fbfbfa;--border:#e6e5e1;--border-strong:#d6d4ce;
  --text:#1b1b18;--muted:#6f6e69;--faint:#a3a19b;
  --code-bg:#fafaf8;--code-no:#b0aea7;--mark:rgba(224,176,0,.16);
  --add-bg:rgba(48,164,108,.10);--add-fg:#1f7a4f;--del-bg:rgba(229,72,77,.09);--del-fg:#b4282d;
  --t-kw:#8e3fb5;--t-str:#2e7d32;--t-num:#b35900;--t-com:#8c8a83;--t-type:#1d5fa8;
  --focus:#3b6fd8;
  --sans:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --bg:#111110;--surface:#191918;--sunken:#151514;--border:#2a2a27;--border-strong:#383834;
  --text:#ecebe7;--muted:#a3a19a;--faint:#6d6b65;
  --code-bg:#141413;--code-no:#5a5852;--mark:rgba(224,176,0,.14);
  --add-bg:rgba(48,164,108,.14);--add-fg:#5fd39a;--del-bg:rgba(229,72,77,.14);--del-fg:#ff8a8d;
  --t-kw:#d197f0;--t-str:#8fd694;--t-num:#ffb36b;--t-com:#77756e;--t-type:#7fb6ff;
  --focus:#7aa2ff;
}}
:root[data-theme="dark"]{
  --bg:#111110;--surface:#191918;--sunken:#151514;--border:#2a2a27;--border-strong:#383834;
  --text:#ecebe7;--muted:#a3a19a;--faint:#6d6b65;
  --code-bg:#141413;--code-no:#5a5852;--mark:rgba(224,176,0,.14);
  --add-bg:rgba(48,164,108,.14);--add-fg:#5fd39a;--del-bg:rgba(229,72,77,.14);--del-fg:#ff8a8d;
  --t-kw:#d197f0;--t-str:#8fd694;--t-num:#ffb36b;--t-com:#77756e;--t-type:#7fb6ff;
  --focus:#7aa2ff;
}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 var(--sans);-webkit-font-smoothing:antialiased}
.wrap{max-width:900px;margin:0 auto;padding:40px 16px 64px}
.mono{font-family:var(--mono)}.small{font-size:12px}.muted{color:var(--muted)}
code{font-family:var(--mono);font-size:.88em;background:color-mix(in srgb,var(--text) 6%,transparent);padding:.08em .32em;border-radius:4px;overflow-wrap:anywhere}
kbd{font-family:var(--mono);font-size:11px;border:1px solid var(--border-strong);border-bottom-width:2px;border-radius:4px;padding:0 5px;background:var(--surface)}

/* masthead */
.eyebrow{font-size:12px;color:var(--muted);letter-spacing:.02em;overflow-wrap:anywhere}
.eyebrow .mono{font-size:11.5px}
h1{font-size:26px;line-height:1.25;font-weight:650;margin:6px 0 18px;letter-spacing:-.01em;display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 10px}
h1 .kind{font-weight:500;color:var(--muted);font-size:18px}
h1 .sha{font-family:var(--mono);font-weight:600;font-size:22px}
h1 .range{font-family:var(--mono);color:var(--faint);font-weight:400;margin:0 -6px}
h1 .repo{font-size:13px;font-weight:500;color:var(--muted);border:1px solid var(--border);border-radius:999px;padding:1px 10px;align-self:center}
.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));border:1px solid var(--border);border-radius:10px;background:var(--surface);overflow:hidden}
.stat{padding:12px 14px;display:flex;flex-direction:column;gap:2px;border-left:1px solid var(--border)}
.stat:first-child{border-left:0}
.stat .v{font-size:19px;font-weight:620;font-variant-numeric:tabular-nums}
.stat .k{font-size:12px;color:var(--muted)}
.facts{display:grid;grid-template-columns:max-content 1fr;gap:7px 16px;margin:18px 0 0;font-size:13.5px}
.facts dt{color:var(--muted)}
.facts dd{margin:0;min-width:0}
.ok{color:var(--clean);font-weight:550}
.warn{color:var(--p1)}

.lens{display:inline-block;font-size:12px;line-height:18px;padding:0 7px;border-radius:5px;border:1px solid var(--border);color:var(--muted);background:var(--sunken);white-space:nowrap;margin:1px 0}
.lens.off{text-decoration:line-through;text-decoration-color:var(--faint)}

/* summary */
.summary{margin:34px 0 14px}
.summary-top{display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap}
h2{font-size:18px;margin:0;font-weight:640}
.tally{display:flex;gap:14px;font-size:13px;color:var(--muted)}
.tally b{color:var(--text);font-variant-numeric:tabular-nums;margin-left:2px}
.dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:1px}
.bar{display:flex;gap:3px;height:10px;margin:10px 0 8px}
.seg{border-radius:3px;min-width:6px}
.pr-P1{background:var(--p1)}.pr-P2{background:var(--p2)}.pr-P3{background:var(--p3)}.pr-none{background:var(--pn)}.pr-clean{background:var(--clean)}
.aside{display:flex;gap:16px;font-size:13px;flex-wrap:wrap}
.aside a{color:var(--muted);text-decoration:none;border-bottom:1px dotted var(--faint)}
.aside a:hover{color:var(--text)}
.progress{margin-left:auto;color:var(--muted)}

/* filters */
.filters{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:10px;padding:10px 0;margin-bottom:6px;background:color-mix(in srgb,var(--bg) 88%,transparent);backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px);border-bottom:1px solid var(--border)}
.chips{display:flex;gap:6px;overflow-x:auto;scrollbar-width:none;flex:1;min-width:0}
.chips::-webkit-scrollbar{display:none}
.sep{width:1px;background:var(--border-strong);margin:4px 2px;flex:none}
.chip{flex:none;font:inherit;font-size:12.5px;line-height:1;padding:6px 10px;border-radius:999px;border:1px solid var(--border);background:var(--surface);color:var(--text);cursor:pointer;display:inline-flex;align-items:center}
.chip .dot{margin-right:5px;vertical-align:0}
.chip .count{color:var(--muted);margin-left:6px;font-variant-numeric:tabular-nums}
.chip:hover{border-color:var(--border-strong)}
.chip[aria-pressed="true"]{background:var(--text);color:var(--bg);border-color:var(--text)}
.chip[aria-pressed="true"] .count{color:inherit;opacity:.7}
.shown{font-size:12px;color:var(--muted);white-space:nowrap}

/* cards */
.cards{display:flex;flex-direction:column;gap:14px;padding-top:8px}
.card{--accent:var(--pn);position:relative;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:16px 18px 16px 20px;outline:none;scroll-margin-top:64px;transition:opacity .15s,border-color .15s}
.card::before{content:"";position:absolute;left:-1px;top:14px;bottom:14px;width:3px;border-radius:0 3px 3px 0;background:var(--accent)}
.card[data-priority="P1"]{--accent:var(--p1)}.card[data-priority="P2"]{--accent:var(--p2)}.card[data-priority="P3"]{--accent:var(--p3)}
.card:focus,.card.current{border-color:var(--border-strong);box-shadow:0 0 0 2px color-mix(in srgb,var(--focus) 55%,transparent)}
.card.is-done{opacity:.5}
.card.is-done .claim{text-decoration:line-through;text-decoration-color:var(--faint)}
.card-head{display:flex;flex-wrap:wrap;align-items:center;gap:6px}
.pill{font-size:11.5px;font-weight:700;line-height:20px;padding:0 8px;border-radius:5px;color:#1b1400;letter-spacing:.02em}
.pill.pr-P1{color:#fff}
.pill.pr-none{background:transparent;border:1px solid var(--border-strong);color:var(--muted);line-height:18px}
.tag{font-family:var(--mono);font-size:11.5px;line-height:20px;padding:0 7px;border-radius:5px;background:color-mix(in srgb,var(--text) 7%,transparent);color:var(--text);cursor:help}
.tag-refuted,.tag-dropped{color:var(--muted)}
.loc{margin-left:auto;font-family:var(--mono);font-size:12.5px;color:var(--muted);background:none;border:0;padding:2px 4px;border-radius:4px;cursor:copy;overflow-wrap:anywhere;text-align:right}
.loc:hover{color:var(--text);background:var(--sunken)}
.loc.copied::after{content:" copied";color:var(--clean)}
.done{flex:none;width:24px;height:24px;border-radius:6px;border:1px solid var(--border);background:var(--surface);color:var(--faint);cursor:pointer;font-size:12px;line-height:1;padding:0}
.done[aria-pressed="true"]{background:var(--clean);border-color:var(--clean);color:#fff}
.claim{font-size:16px;line-height:1.5;font-weight:540;margin:10px 0 8px;letter-spacing:-.003em}
.claim code{font-weight:500}
.support{margin:0 0 10px;color:var(--muted);font-size:14px}
.support-label{display:inline-block;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--faint);margin-right:8px}
.support code{color:var(--text)}
.more{font-size:13.5px;color:var(--muted);margin:0 0 8px}
.more summary{cursor:pointer;font-size:12.5px;color:var(--muted);list-style:none}
.more summary::before{content:"\25B8  ";color:var(--faint)}
.more[open] summary::before{content:"\25BE  "}
.more p,.more ul{margin:6px 0 0 14px;padding:0}
.more li{margin:3px 0;list-style:none}
.meta-line{font-size:12.5px;color:var(--muted);margin:0 0 8px}
.tests{display:flex;gap:8px;font-size:13px;margin:0 0 10px;padding:8px 10px;border-radius:8px;background:color-mix(in srgb,var(--clean) 8%,transparent);border:1px solid color-mix(in srgb,var(--clean) 22%,transparent)}
.tests-label{flex:none;font-size:11px;font-weight:650;text-transform:uppercase;letter-spacing:.06em;color:var(--clean);padding-top:2px}

/* evidence */
.evidence{margin-top:12px;border:1px solid var(--border);border-radius:9px;overflow:hidden;background:var(--code-bg)}
.ev-bar{display:flex;align-items:stretch;gap:0;border-bottom:1px solid var(--border);background:var(--sunken);overflow-x:auto;scrollbar-width:none}
.ev-bar::-webkit-scrollbar{display:none}
.ev-tab{flex:none;font:inherit;font-family:var(--mono);font-size:12px;padding:7px 12px;border:0;border-right:1px solid var(--border);background:none;color:var(--muted);cursor:pointer;white-space:nowrap}
.ev-tab .at{color:var(--faint);margin-left:2px}
.ev-tab.cited::before{content:"\21B3  ";color:var(--faint)}
.ev-tab[aria-selected="true"]{background:var(--code-bg);color:var(--text);box-shadow:inset 0 -2px 0 var(--accent)}
.ev-badge{margin-left:auto;align-self:center;font-size:11.5px;color:var(--faint);padding:0 12px;white-space:nowrap}
.code{overflow-x:auto;font-family:var(--mono);font-size:12.5px;line-height:1.6;padding:6px 0}
.code-inner{display:inline-block;min-width:100%}
.row{display:flex;white-space:pre;padding-right:16px}
.row .no{flex:none;width:44px;text-align:right;padding-right:12px;color:var(--code-no);user-select:none;font-variant-numeric:tabular-nums}
.diff .row .no{width:38px;padding-right:8px}
.row .sign{flex:none;width:16px;color:var(--faint);user-select:none}
.row.mark{background:var(--mark);box-shadow:inset 3px 0 0 var(--accent)}
.row.mark .no{color:var(--text);font-weight:600}
.row.add{background:var(--add-bg)}.row.add .sign{color:var(--add-fg)}
.row.del{background:var(--del-bg)}.row.del .sign{color:var(--del-fg)}
.row.add.mark{background:linear-gradient(var(--mark),var(--mark)),var(--add-bg)}
.row.hunk{color:var(--faint);padding:2px 12px 4px;font-size:11.5px}
.row.fold .src{color:var(--faint);font-style:italic}
.t-kw{color:var(--t-kw)}.t-str{color:var(--t-str)}.t-num{color:var(--t-num)}.t-com{color:var(--t-com);font-style:italic}.t-type{color:var(--t-type)}

/* collapsed groups */
.group{margin-top:22px;border-top:1px solid var(--border);padding-top:14px}
.group summary{cursor:pointer;display:flex;align-items:baseline;gap:10px;list-style:none;flex-wrap:wrap}
.group summary::-webkit-details-marker{display:none}
.group summary::before{content:"\25B8";color:var(--faint);font-size:12px;width:10px}
.group[open] summary::before{content:"\25BE"}
.group-title{font-weight:620;font-size:15.5px}
.group .count{font-size:12px;color:var(--muted);background:var(--sunken);border:1px solid var(--border);border-radius:999px;padding:0 8px;font-variant-numeric:tabular-nums}
.group-blurb{font-size:13px;color:var(--muted)}
.group .card{background:var(--sunken)}
.group .claim{font-size:15px;font-weight:530}
.clean{display:flex;align-items:center;font-size:15px;color:var(--muted);padding:24px 0}
.card.filtered{display:none}

.foot{margin-top:40px;padding-top:16px;border-top:1px solid var(--border);display:flex;flex-wrap:wrap;gap:8px 18px;font-size:12.5px;color:var(--muted)}
.foot .muted{flex-basis:100%;color:var(--faint)}

@media (max-width:640px){
  .wrap{padding-top:24px}
  h1{font-size:21px}h1 .sha{font-size:18px}h1 .kind{font-size:15px}
  .stats{grid-template-columns:repeat(2,minmax(0,1fr))}
  .stat:nth-child(3){border-left:0}
  .stat:nth-child(n+3){border-top:1px solid var(--border)}
  .facts{grid-template-columns:1fr;gap:2px}
  .facts dd{margin-bottom:8px}
  .card{padding:14px 14px 14px 16px}
  .loc{margin-left:0;flex-basis:100%;text-align:left;order:9;padding-left:0}
  .done{margin-left:auto}
  .claim{font-size:15.5px}
  .code{font-size:11.5px}
  .row .no{width:34px;padding-right:8px}
  .diff .row .no{width:30px;padding-right:6px}
  .ev-badge{display:none}
  .shown{display:none}
}
@media (prefers-reduced-motion:reduce){.card{transition:none}}
`

const JS = String.raw`
(() => {
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const store = (() => { try { return window.localStorage } catch { return undefined } })();
  const KEY = "gauntlet:dossier:" + RUN_ID;
  let done = new Set();
  try { done = new Set(JSON.parse(store?.getItem(KEY) ?? "[]")) } catch {}
  const save = () => { try { store?.setItem(KEY, JSON.stringify([...done])) } catch {} };

  const allCards = $$(".card");
  const findingCards = $$("#findings .card");

  // Evidence tabs
  for (const ev of $$(".evidence")) {
    ev.addEventListener("click", (e) => {
      const tab = e.target.closest(".ev-tab"); if (!tab) return;
      select(ev, tab.dataset.tab);
    });
  }
  function select(ev, id) {
    for (const t of $$(".ev-tab", ev)) t.setAttribute("aria-selected", String(t.dataset.tab === id));
    for (const p of $$(".ev-pane", ev)) p.hidden = p.dataset.pane !== id;
  }
  function cycle(card) {
    const ev = card.querySelector(".evidence"); if (!ev) return;
    const tabs = $$(".ev-tab", ev);
    const i = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
    select(ev, tabs[(i + 1) % tabs.length].dataset.tab);
  }

  // Reviewed marks
  function paint(card) {
    const on = done.has(card.dataset.key);
    card.classList.toggle("is-done", on);
    card.querySelector(".done").setAttribute("aria-pressed", String(on));
  }
  function toggleDone(card) {
    const k = card.dataset.key;
    done.has(k) ? done.delete(k) : done.add(k);
    save(); paint(card); progress();
  }
  function progress() {
    const n = findingCards.filter((c) => done.has(c.dataset.key)).length;
    const el = document.getElementById("progress");
    if (el) el.textContent = findingCards.length ? n + " of " + findingCards.length + " reviewed" : "";
  }
  for (const c of allCards) {
    paint(c);
    c.querySelector(".done").addEventListener("click", () => toggleDone(c));
    c.querySelector(".loc").addEventListener("click", (e) => copyLoc(c, e.currentTarget));
    c.addEventListener("click", (e) => { if (!e.target.closest("button,a,summary")) setCurrent(c, false) });
  }
  progress();

  function copyLoc(card, btn = card.querySelector(".loc")) {
    const text = btn.textContent;
    navigator.clipboard?.writeText(text).then(() => {
      btn.classList.add("copied"); setTimeout(() => btn.classList.remove("copied"), 1100);
    }).catch(() => {});
  }

  // Filters: within a kind, chips OR together; across kinds they AND.
  const active = { priority: new Set(), lens: new Set() };
  for (const chip of $$(".chip")) {
    chip.addEventListener("click", () => {
      const set = active[chip.dataset.kind], v = chip.dataset.value;
      set.has(v) ? set.delete(v) : set.add(v);
      chip.setAttribute("aria-pressed", String(set.has(v)));
      apply();
    });
  }
  function apply() {
    let shown = 0;
    for (const c of allCards) {
      const okP = active.priority.size === 0 || active.priority.has(c.dataset.priority);
      const lenses = c.dataset.lenses.split(" ");
      const okL = active.lens.size === 0 || lenses.some((l) => active.lens.has(l));
      c.classList.toggle("filtered", !(okP && okL));
      if (okP && okL && findingCards.includes(c)) shown++;
    }
    const el = document.getElementById("shown");
    if (el) el.textContent = active.priority.size || active.lens.size ? shown + " of " + findingCards.length + " shown" : "";
  }

  // Keyboard: j/k walk the visible cards, including any open group.
  let current = null;
  function setCurrent(c, scroll = true) {
    current?.classList.remove("current");
    current = c; c.classList.add("current");
    c.focus({ preventScroll: true });
    if (scroll) c.scrollIntoView({ block: "start", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }
  const visible = () => allCards.filter((c) => c.offsetParent !== null);
  document.addEventListener("keydown", (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const list = visible(); if (!list.length) return;
    const i = current ? list.indexOf(current) : -1;
    if (e.key === "j") setCurrent(list[Math.min(list.length - 1, i + 1)]);
    else if (e.key === "k") setCurrent(list[Math.max(0, i - 1)]);
    else if (e.key === "d" && current) cycle(current);
    else if (e.key === "x" && current) toggleDone(current);
    else if (e.key === "c" && current) copyLoc(current);
    else return;
    e.preventDefault();
  });
})();
`

const [runDir, out] = process.argv.slice(2)
if (runDir === undefined || out === undefined) {
  console.error("usage: bun render.ts <run-dir> <out.html>")
  process.exit(2)
}
writeFileSync(out, render(runDir))
console.log(`wrote ${out}`)
