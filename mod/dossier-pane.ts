// The Dossier as a pane of the session (`$.ui.open`), docked beside the
// transcript or above the prompt: one finding at a time, its claim, why it
// stands and the code it names, the change's hunk at that line when the
// change touched it, else the lines around it. dossier.json is read through
// the shared view (src/render/dossier-view.ts) the markdown is written from,
// and dossier.md stays the Dossier; the pane is a reading of it. Its evidence
// comes from git at the reviewed commit, or from the working tree for a
// working-tree review, as it is now.
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { Dossier } from "../src/domain/dossier.ts"
import { TargetIdentity } from "../src/domain/review-target.ts"
import type { ReviewPriority } from "../src/domain/verdict.ts"
import { type DossierEntryTag, type DossierEntryView, viewDossier } from "../src/render/dossier-view.ts"
import { runGit } from "../src/target/git.ts"

export interface PaneFinding {
  readonly id: string
  readonly tag: DossierEntryTag
  readonly reviewPriority: ReviewPriority | undefined
  readonly lenses: ReadonlyArray<string>
  readonly file: string
  readonly line: number | undefined
  readonly summary: string
  readonly detail: string | undefined
  readonly tests: ReadonlyArray<string>
  // The change's hunk over the line, or the lines around it.
  readonly evidence:
    | { readonly _tag: "Hunk"; readonly source: string }
    | { readonly _tag: "Excerpt"; readonly source: string; readonly startLine: number }
    | undefined
}

export interface DossierPane {
  readonly runId: string
  readonly runDirectory: string
  readonly target: string
  readonly entries: ReadonlyArray<PaneFinding>
  readonly coverageGaps: number
  readonly rejected: number
}

const decodeDossier = Schema.decodeUnknownEffect(Schema.fromJsonString(Dossier))

const AROUND = 6

// The hunks of one file's diff whose new side covers `line`.
const hunkAt = (diff: string, line: number) => {
  const hunks = diff.split(/^(?=@@ )/m).filter((part) => part.startsWith("@@ "))
  return hunks.find((hunk) => {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/.exec(hunk)
    if (header === null) return false
    const start = Number(header[1])
    const count = header[2] === undefined ? 1 : Number(header[2])
    return line >= start && line < start + Math.max(count, 1)
  })?.trimEnd()
}

export const loadDossierPane = Effect.fn("DossierPane.load")(function* (runDirectory: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dossier = yield* decodeDossier(yield* fs.readFileString(path.join(runDirectory, "dossier.json")))
  const view = viewDossier(dossier)
  const target = dossier.target
  const workingTree = target._tag === "WorkingTree"
  const range = workingTree ? [target.baseCommit ?? target.headCommit] : [target.baseCommit, target.headCommit]
  const listed: ReadonlyArray<DossierEntryView> = [...view.findings, ...view.unresolved]
  const evidenceOf = Effect.fn("DossierPane.evidence")(function* (entry: DossierEntryView) {
    const { file, line } = entry.candidate
    if (line === undefined) return undefined
    const diff = yield* runGit(target.repoRoot, ["diff", "--no-color", "--no-ext-diff", ...range, "--", file]).pipe(
      Effect.orElseSucceed(() => ""),
    )
    const hunk = hunkAt(diff, line)
    if (hunk !== undefined) return { _tag: "Hunk" as const, source: hunk }
    const text = yield* (workingTree
      ? Effect.option(fs.readFileString(path.join(target.repoRoot, file)))
      : Effect.option(runGit(target.repoRoot, ["show", `${target.headCommit}:${file}`])))
    if (text._tag === "None") return undefined
    const startLine = Math.max(1, line - AROUND)
    return {
      _tag: "Excerpt" as const,
      source: text.value.split("\n").slice(startLine - 1, line + AROUND).join("\n"),
      startLine,
    }
  })
  const entries = yield* Effect.forEach(listed, (entry) =>
    evidenceOf(entry).pipe(Effect.map((evidence): PaneFinding => ({
      id: entry.candidate.id,
      tag: entry.tag,
      reviewPriority: entry.reviewPriority,
      lenses: entry.lenses,
      file: entry.candidate.file,
      line: entry.candidate.line,
      summary: entry.candidate.summary,
      detail: entry.detail,
      tests: entry.testSuggestion?.tests ?? [],
      evidence,
    }))), { concurrency: "unbounded" })
  const short = (sha: string) => sha.slice(0, 7)
  const described = TargetIdentity.match(target, {
    PullRequest: ({ baseCommit, headCommit, number }) => `PR #${String(number)} ${short(baseCommit)}..${short(headCommit)}`,
    Commits: ({ baseCommit, headCommit }) => `${short(baseCommit)}..${short(headCommit)}`,
    WorkingTree: ({ headCommit }) => `working tree on ${short(headCommit)}`,
  })
  return {
    runId: dossier.runId,
    runDirectory,
    target: `${path.basename(target.repoRoot)} ${described}`,
    entries,
    coverageGaps: dossier.coverageGaps.length,
    rejected: view.refutedClaims.length + view.droppedObservations.length,
  } satisfies DossierPane
})

interface PaneButton {
  readonly key: string
  readonly label: string
  readonly hotkey: string
  readonly onPress: () => void
}

// The slice of every surface's element table the pane draws with.
export interface DossierElements<N> {
  readonly Box: (props: {
    readonly key?: string
    readonly flexDirection?: "row" | "column"
    readonly flexGrow?: number
    readonly flexShrink?: number
    readonly minWidth?: number
    readonly alignItems?: "center"
    readonly gap?: number
    readonly marginTop?: number
    readonly paddingX?: number
    readonly borderStyle?: string
    readonly borderColor?: string
    readonly width?: number | string
    readonly children?: N | string | ReadonlyArray<N>
  }) => N
  readonly Text: (props: {
    readonly bold?: boolean
    readonly dimColor?: boolean
    readonly color?: string
    readonly wrap?: "truncate-end"
    readonly children?: string
  }) => N
  readonly Button: (props: PaneButton) => N
  readonly Markdown: (props: { readonly text: string; readonly dimColor?: boolean }) => N
  readonly Code: (props: {
    readonly source: string
    readonly path?: string
    readonly startLine?: number
    readonly format?: "source" | "diff"
  }) => N
}

export interface DossierPaneActions {
  readonly select: (at: number) => void
  readonly explain: (finding: PaneFinding) => void
  readonly openMarkdown: () => void
}

const PRIORITY_COLOR = { P1: "red", P2: "#ff8700", P3: "warning" } as const

const TAG_WORD: Record<DossierEntryTag, string> = {
  confirmed: "confirmed",
  judgment: "kept",
  plausible: "plausible",
  undecided: "undecided",
  refuted: "refuted",
  dropped: "dropped",
}

const location = (finding: PaneFinding) => finding.line === undefined ? finding.file : `${finding.file}:${String(finding.line)}`

const clip = (text: string, length: number) => text.length <= length ? text : `${text.slice(0, length - 1).trimEnd()}…`

const mark = <N>(el: DossierElements<N>, finding: PaneFinding) =>
  finding.reviewPriority === undefined
    ? el.Text({ dimColor: true, children: TAG_WORD[finding.tag] })
    : el.Text({ color: PRIORITY_COLOR[finding.reviewPriority], bold: true, children: finding.reviewPriority })

// `at` is the finding shown; the index above it lists every one.
export const renderDossierPane = <N>(pane: DossierPane, el: DossierElements<N>, at: number, actions: DossierPaneActions): N => {
  const { Box, Text, Markdown, Code } = el
  const finding = pane.entries[at]
  const index = pane.entries.map((each, nth) => {
    const line = `${each.reviewPriority ?? TAG_WORD[each.tag]} · \`${location(each)}\` — ${clip(each.summary, 72)}`
    return nth === at ? `- **▸ ${line}**` : `- ${line}`
  }).join("\n")
  const heading = Box({
    flexDirection: "row",
    alignItems: "center",
    children: [
      Box({ flexShrink: 0, children: Text({ color: "#d7875f", bold: true, children: "◆ Gauntlet dossier" }) }),
      Text({
        dimColor: true,
        wrap: "truncate-end",
        children: ` · ${pane.target} · ${String(pane.entries.length)} to read` +
          (pane.coverageGaps === 0 ? "" : ` · ${String(pane.coverageGaps)} coverage gaps`) +
          (pane.rejected === 0 ? "" : ` · ${String(pane.rejected)} rejected`),
      }),
    ],
  })
  if (finding === undefined) {
    return Box({ flexDirection: "column", children: [heading, Markdown({ text: "Nothing to read: the review found nothing that held." })] })
  }
  const evidence = finding.evidence === undefined
    ? []
    : finding.evidence._tag === "Hunk"
    ? [Text({ dimColor: true, children: `the change at ${location(finding)}` }), Code({ source: finding.evidence.source, path: finding.file, format: "diff" })]
    : [Text({ dimColor: true, children: `${location(finding)}, as reviewed` }), Code({ source: finding.evidence.source, path: finding.file, startLine: finding.evidence.startLine })]
  const card = Box({
    key: `finding-${finding.id}`,
    flexDirection: "column",
    borderStyle: "round",
    borderColor: finding.reviewPriority === undefined ? "gray" : PRIORITY_COLOR[finding.reviewPriority],
    paddingX: 1,
    gap: 1,
    children: [
      Box({
        flexDirection: "row",
        children: [
          mark(el, finding),
          Text({ dimColor: true, children: ` ${finding.reviewPriority === undefined ? "" : `${TAG_WORD[finding.tag]} · `}${finding.lenses.join(", ")} · ` }),
          Text({ bold: true, children: location(finding) }),
        ],
      }),
      Markdown({ text: finding.summary }),
      ...(finding.detail === undefined ? [] : [Markdown({ dimColor: true, text: finding.detail })]),
      ...evidence,
      ...(finding.tests.length === 0 ? [] : [Markdown({ dimColor: true, text: `Tests worth running: ${finding.tests.map((test) => `\`${test}\``).join(", ")}` })]),
    ],
  })
  const last = pane.entries.length - 1
  return Box({
    flexDirection: "column",
    gap: 1,
    children: [
      heading,
      Markdown({ text: index }),
      card,
      Box({
        flexDirection: "row",
        gap: 1,
        alignItems: "center",
        children: [
          el.Button({ key: "previous", label: "‹ Previous", hotkey: "k", onPress: () => actions.select(at === 0 ? last : at - 1) }),
          el.Button({ key: "next", label: "Next ›", hotkey: "j", onPress: () => actions.select(at === last ? 0 : at + 1) }),
          el.Button({ key: "explain", label: "Explain", hotkey: "e", onPress: () => actions.explain(finding) }),
          el.Button({ key: "markdown", label: "dossier.md", hotkey: "m", onPress: actions.openMarkdown }),
          Text({ dimColor: true, children: `${String(at + 1)} of ${String(pane.entries.length)}` }),
        ],
      }),
    ],
  })
}

// What Explain asks the main agent: the finding named so it can read its
// entry, and a visual of the problem and the fix.
export const explainPrompt = (pane: DossierPane, finding: PaneFinding) =>
  `Explain Gauntlet finding ${finding.reviewPriority ?? TAG_WORD[finding.tag]} ${location(finding)} from run ${pane.runId} visually: ` +
  `its entry is \`${finding.id}\` in ${pane.runDirectory}/dossier.json.`
