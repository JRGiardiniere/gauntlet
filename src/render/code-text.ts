// Code as page text: HTML escaping, a reviewed diff split into hunks, and a
// small highlighter for the Dossier page. The highlighter marks comments,
// strings, numbers, keywords and type names; the page styles them with
// weight and tone only.

export const escapeHtml = (text: string): string =>
  text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")

export interface DiffRow {
  readonly kind: "context" | "added" | "removed"
  readonly oldLine?: number
  readonly newLine?: number
  readonly text: string
}

export interface Hunk {
  readonly header: string
  readonly newStart: number
  readonly newLength: number
  readonly rows: ReadonlyArray<DiffRow>
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/

// Hunks by the file's path after the change. A deleted file has no lines
// after the change, so it has no hunks to cite. A hunk's header counts its
// lines, so an added line that reads "++ x" stays a row, not a file header.
export const parseDiffHunks = (
  diff: string,
): ReadonlyMap<string, ReadonlyArray<Hunk>> => {
  const files = new Map<string, Array<Hunk>>()
  let hunks: Array<Hunk> | undefined
  let rows: Array<DiffRow> = []
  let oldLine = 0
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  for (const line of diff.split("\n")) {
    if (hunks !== undefined && (oldLeft > 0 || newLeft > 0)) {
      if (line.startsWith("+")) {
        rows.push({ kind: "added", newLine: newLine++, text: line.slice(1) })
        newLeft--
      } else if (line.startsWith("-")) {
        rows.push({ kind: "removed", oldLine: oldLine++, text: line.slice(1) })
        oldLeft--
      } else if (line.startsWith(" ")) {
        rows.push({ kind: "context", oldLine: oldLine++, newLine: newLine++, text: line.slice(1) })
        oldLeft--
        newLeft--
      }
      continue
    }
    if (line.startsWith("diff --git ")) {
      hunks = undefined
      continue
    }
    if (line.startsWith("+++ ")) {
      const path = line.slice(4)
      hunks = path.startsWith("b/") ? [] : undefined
      if (hunks !== undefined) files.set(path.slice(2), hunks)
      continue
    }
    const header = HUNK_HEADER.exec(line)
    if (header !== null && hunks !== undefined) {
      oldLine = Number(header[1])
      oldLeft = header[2] === undefined ? 1 : Number(header[2])
      newLine = Number(header[3])
      newLeft = header[4] === undefined ? 1 : Number(header[4])
      rows = []
      hunks.push({ header: line, newStart: newLine, newLength: newLeft, rows })
    }
  }
  return files
}

export const hunkAt = (
  hunks: ReadonlyArray<Hunk>,
  line: number,
): Hunk | undefined =>
  hunks.find((hunk) =>
    line >= hunk.newStart && line < hunk.newStart + Math.max(hunk.newLength, 1)
  )

const KEYWORDS = new Set(
  "import export from const let var function return if else for while do of in new type interface extends implements class readonly as async await yield throw try catch finally switch case default break continue typeof keyof void undefined null true false this satisfies declare namespace enum"
    .split(" "),
)
const TOKEN =
  /(\/\/.*$)|(\/\*.*?(?:\*\/|$))|("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?|`(?:[^`\\]|\\.)*`?)|(#[0-9a-fA-F]{3,8}\b|\b\d[\d_]*(?:\.\d+)?\b)|([A-Za-z_$][\w$]*)/g

const span = (kind: string, text: string) =>
  `<span class="t-${kind}">${escapeHtml(text)}</span>`

// One highlighter per run of consecutive lines: a block comment opened on
// one line stays a comment on the next. Files it doesn't know are escaped.
export const lineHighlighter = (file: string): (line: string) => string => {
  if (!/\.(?:[cm]?[jt]sx?|json)$/.test(file)) return escapeHtml
  let inBlockComment = false
  return (line) => {
    let html = ""
    let rest = line
    if (inBlockComment) {
      const end = rest.indexOf("*/")
      if (end === -1) return span("com", rest)
      html += span("com", rest.slice(0, end + 2))
      rest = rest.slice(end + 2)
      inBlockComment = false
    }
    let last = 0
    for (const match of rest.matchAll(TOKEN)) {
      const [token, lineComment, blockComment, string, number, word] = match
      html += escapeHtml(rest.slice(last, match.index))
      last = match.index + token.length
      if (lineComment !== undefined) html += span("com", token)
      else if (blockComment !== undefined) {
        inBlockComment = !token.endsWith("*/")
        html += span("com", token)
      } else if (string !== undefined) html += span("str", token)
      else if (number !== undefined) html += span("num", token)
      else if (word !== undefined && KEYWORDS.has(word)) html += span("kw", token)
      else if (word !== undefined && /^[A-Z]/.test(word)) html += span("type", token)
      else html += escapeHtml(token)
    }
    return html + escapeHtml(rest.slice(last))
  }
}
