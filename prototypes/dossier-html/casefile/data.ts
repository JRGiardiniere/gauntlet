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

export { CITATION, esc, git, highlighter, parseHunks, readHeaderFacts, Repo, viewDossier }
export type { Candidate, Dossier, Entry, EntryTag, HeaderFacts, Hunk, Priority }
