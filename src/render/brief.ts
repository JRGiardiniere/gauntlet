// A brief: an agent's explanation of one finding, written as markdown in the
// run directory (briefs/<finding id>.md) and drawn on its exhibit. The agent
// writes content only; three kinds of fenced block carry what plain markdown
// can't, and the page draws them in its own frames:
//
//   ```code mod/strip.ts:247-256 @a1acde9 mark=250,254
//   ```                       — reviewed lines (or a commit's), read for it
//   ```sketch                 — a call tree, file tree or pseudocode; lines
//   ```                         starting + or − read as a change to it
//   ```ts                     — an illustration, not from the repository
//
// A first-level heading is the brief's takeaway. Raw HTML stays text.
import MarkdownIt from "markdown-it"
import { escapeHtml, lineHighlighter } from "./code-text.ts"
import { code, excerpt, frame } from "./page-frames.ts"

export interface CodeReference {
  readonly file: string
  readonly revision: string | undefined
  readonly from: number
  readonly to: number
  readonly marked: ReadonlyArray<number>
}

// Lines by file for the reviewed code, by file@commit for a commit's.
export const sourceKey = (file: string, revision?: string) =>
  revision === undefined ? file : `${file}@${revision}`

const CODE_FENCE =
  /^code\s+(\S+?):(\d+)(?:[-–](\d+))?(?:\s+@([0-9A-Za-z._/~^-]+))?(?:\s+mark=([\d,\s-]+))?\s*$/

const lineNumbers = (spec: string): ReadonlyArray<number> =>
  spec.split(",").flatMap((part) => {
    const [from, to] = part.trim().split("-").map(Number)
    if (from === undefined || Number.isNaN(from)) return []
    const last = to === undefined || Number.isNaN(to) ? from : to
    return Array.from({ length: Math.max(0, last - from + 1) }, (_, i) => from + i)
  })

const codeReference = (info: string): CodeReference | undefined => {
  const match = CODE_FENCE.exec(info.trim())
  if (match === null) return undefined
  const from = Number(match[2])
  const to = match[3] === undefined ? from : Number(match[3])
  return {
    file: match[1] ?? "",
    from,
    to,
    marked: match[5] === undefined ? [] : lineNumbers(match[5]),
    revision: match[4],
  }
}

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false })

const fences = (text: string) =>
  markdown.parse(text, {}).filter((token) => token.type === "fence")

// The code a brief shows, for its caller to read before drawing it.
export const briefReferences = (text: string): ReadonlyArray<CodeReference> =>
  fences(text).flatMap((token) => {
    const reference = codeReference(token.info)
    return reference === undefined ? [] : [reference]
  })

export interface RenderedBrief {
  readonly takeaway: string | undefined
  readonly html: string
  // What the brief asked for that the page could not draw, worded for the
  // agent that wrote it.
  readonly problems: ReadonlyArray<string>
}

const sketch = (body: string) => {
  const lines = body.replace(/\n$/, "").split("\n")
  const change = lines.some((line) => /^[+-]/.test(line))
  const rows = lines.map((line) => {
    const kind = !change ? "" : line.startsWith("+") ? " add" : line.startsWith("-") ? " del" : " ctx"
    // A context line keeps its first character unless it is the space
    // that lines it up with the signs.
    const signed = /^[+\- ]/.test(line)
    const text = change && signed ? line.slice(1) : line
    const sign = change ? `<span class="sign">${line.startsWith("-") ? "−" : line.startsWith("+") ? "+" : ""}</span>` : ""
    return `<div class="row${kind}">${sign}<span class="src">${escapeHtml(text) || " "}</span></div>`
  })
  return frame(
    `<span class="ev-kind">Sketch</span>`,
    code(rows, change ? " diff sketch" : " sketch"),
  )
}

const illustration = (language: string, body: string) => {
  const highlight = lineHighlighter(`illustration.${language || "txt"}`)
  const rows = body.replace(/\n$/, "").split("\n").map((line) =>
    `<div class="row"><span class="src">${highlight(line) || " "}</span></div>`
  )
  return frame(
    `<span class="ev-kind">Illustration</span><span class="ev-rev">not from the repository</span>`,
    code(rows, " snippet"),
  )
}

interface BriefContext {
  readonly sources: (key: string) => ReadonlyArray<string> | undefined
  readonly pin: string
  readonly problems: Array<string>
}

const drawReference = (reference: CodeReference, context: BriefContext) => {
  const at = `${reference.file}:${reference.from}${reference.to === reference.from ? "" : `-${reference.to}`}`
  const lines = context.sources(sourceKey(reference.file, reference.revision))
  if (lines === undefined) {
    context.problems.push(
      reference.revision === undefined
        ? `${reference.file} is not a file the page can show as reviewed; name a commit with @<commit>`
        : `${reference.file} does not exist at ${reference.revision}`,
    )
    return ""
  }
  if (reference.from > lines.length || reference.to < reference.from) {
    context.problems.push(`${at} is outside the file's ${lines.length} lines`)
    return ""
  }
  return excerpt({
    file: reference.file,
    lines,
    from: reference.from,
    to: Math.min(reference.to, reference.from + 80),
    marked: new Set(reference.marked),
    pin: context.pin,
    revision: reference.revision,
  })
}

export const renderBrief = (
  text: string,
  pin: string,
  sources: (key: string) => ReadonlyArray<string> | undefined,
): RenderedBrief => {
  const context: BriefContext = { sources, pin, problems: [] }
  const renderer = new MarkdownIt({ html: false, linkify: false, typographer: false })
  renderer.renderer.rules.fence = (tokens, index) => {
    const info = tokens[index]?.info.trim() ?? ""
    const body = tokens[index]?.content ?? ""
    const language = info.split(/\s+/)[0] ?? ""
    if (language === "sketch") return sketch(body)
    if (language !== "code") return illustration(language, body)
    const reference = codeReference(info)
    if (reference === undefined) {
      context.problems.push(
        `\`\`\`${info} is not a code reference: write \`\`\`code <file>:<from>-<to> [@<commit>] [mark=<lines>]`,
      )
      return ""
    }
    return drawReference(reference, context)
  }
  const tokens = renderer.parse(text, {})
  const opening = tokens[0]?.type === "heading_open" && tokens[0].tag === "h1"
  const takeaway = opening ? tokens[1]?.content : undefined
  const html = renderer.renderer.render(
    opening ? tokens.slice(3) : tokens,
    renderer.options,
    {},
  )
  return {
    html: `<div class="brief-body">${html}</div>`,
    problems: context.problems,
    takeaway,
  }
}
