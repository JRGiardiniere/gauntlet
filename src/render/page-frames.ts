// The pieces every page block is drawn from: inline prose, the evidence
// frame, and an excerpt of reviewed lines with its pinned marks.
import { escapeHtml, lineHighlighter } from "./code-text.ts"

export const inline = (text: string) =>
  escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")

export const paragraphs = (text: string) =>
  text.trim().split(/\n{2,}/).map((paragraph) => {
    const lines = paragraph.split("\n")
    return lines.every((line) => /^\s*[-*] /.test(line))
      ? `<ul>${lines.map((line) => `<li>${inline(line.replace(/^\s*[-*] /, ""))}</li>`).join("")}</ul>`
      : `<p>${inline(paragraph.replace(/\n/g, " "))}</p>`
  }).join("")

export const ICON = {
  check: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6l3 3 6.6-7.2"/></svg>`,
  copy: `<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.2"/><path d="M10.5 3.2V2.8a.8.8 0 00-.8-.8H3.3a.8.8 0 00-.8.8v6.4c0 .4.4.8.8.8h.4"/></svg>`,
  flag: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 14.5V2"/><path d="M4 2.5h8.2l-1.8 3 1.8 3H4"/></svg>`,
  clip: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10.6 5.2l-4.4 4.4a1.3 1.3 0 001.8 1.8l5-5a2.6 2.6 0 00-3.7-3.7l-5.2 5.2a3.9 3.9 0 005.5 5.5l3.9-3.9"/></svg>`,
  brief: `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 2.5h6l3 3v8h-9z"/><path d="M9.5 2.5v3h3M5.8 8.5h4.4M5.8 11h4.4"/></svg>`,
}

export const pinTail = (pin: string) =>
  `<span class="leader" aria-hidden="true"></span><span class="pin">${escapeHtml(pin)}</span>`

export const frame = (head: string, body: string, caption?: string) =>
  `<figure class="evidence"><figcaption class="ev-head">${head}</figcaption>${body}${
    caption === undefined ? "" : `<p class="ev-caption">${inline(caption)}</p>`
  }</figure>`

export const code = (rows: ReadonlyArray<string>, kind = "") =>
  `<div class="code${kind}"><div class="code-inner">${rows.join("")}</div></div>`

export const CONTEXT = 6

export interface Excerpt {
  readonly file: string
  readonly lines: ReadonlyArray<string>
  readonly from: number
  readonly to: number
  readonly marked: ReadonlySet<number>
  readonly pin: string
  readonly caption?: string
  // A commit the lines were read at; otherwise they are the reviewed lines.
  readonly revision?: string | undefined
}

export const excerpt = (
  { caption, file, from, lines, marked, pin, revision, to }: Excerpt,
) => {
  const start = Math.max(1, from)
  const end = Math.min(lines.length, to)
  if (start > end) return ""
  const highlight = lineHighlighter(file)
  // Prime the block-comment state with the lines above the window.
  for (const line of lines.slice(Math.max(0, start - 41), start - 1)) highlight(line)
  const rows: Array<string> = []
  for (let number = start; number <= end; number++) {
    const mark = marked.has(number)
    rows.push(
      `<div class="row${mark ? " mark" : ""}"><span class="no">${number}</span><span class="src">${
        highlight(lines[number - 1] ?? "") || " "
      }</span>${mark ? pinTail(pin) : ""}</div>`,
    )
  }
  return frame(
    `<span class="ev-kind">Source</span><code>${escapeHtml(file)}:${start}${end > start ? `–${end}` : ""}</code><span class="ev-rev">${revision === undefined ? "as reviewed" : `@${escapeHtml(revision.slice(0, 7))}`}</span>`,
    code(rows),
    caption,
  )
}
