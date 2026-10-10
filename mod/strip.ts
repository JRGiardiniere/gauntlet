// The Mod's strip: a review in flight, drawn above the prompt by the hooks
// module's `ui.render` hook on `AbovePrompt`, from one reading of the run
// (`stripState`) laid out two ways. On the terminal, line 1 is each stage with
// one mark per agent, and one per lens skipped by design, and line 2 the
// elapsed time and what the run is doing in plain words; once the dossier is
// written, line 1 is its Review Priority counts with Open dossier and Dismiss.
// Where text is proportional, a heading line (what the run is doing, or how it
// ended, and the buttons) stands over one SVG of the stages, the counts and the
// clock (mod/strip-svg.ts). A pull-request review's post adds a last line,
// wrapped: posting, then where it landed or why it did not. Counts come from
// the Run's milestones and the invocations' activity (mod/activity.ts), never
// from progress text; no dollar or cache figure shows.
import type { RunMilestone, SkippedLens } from "../src/run/run-milestones.ts"
import type { AgentActivity } from "./activity.ts"
import { type MarkState, type TrackStage, trackSvg } from "./strip-svg.ts"

export interface RunView {
  readonly startedAt: number
  readonly endedAt: number | undefined
  // The lenses whose Finders run, and the ones skipped by design with why,
  // from Started.
  readonly lenses: ReadonlyArray<string>
  readonly skipped: ReadonlyArray<SkippedLens>
  readonly findersFinished: boolean
  // What the Finders' candidates became: BugClaims for Verification,
  // Observations for Judgment.
  readonly routed: { readonly bugClaims: number; readonly observations: number } | undefined
  readonly activity: ReadonlyArray<AgentActivity>
  readonly exitCode: number | undefined
  // The digest's surviving entries, the coverage gaps and the dossier's path.
  readonly result: Extract<RunMilestone, { readonly _tag: "Reviewed" }> | undefined
  // Why the review could not run, in the Mod's words.
  readonly refusal: string | undefined
  // A pull-request review's post: under way, then where it landed or why it
  // did not.
  readonly post: { readonly state: "posting" | "posted" | "failed"; readonly text: string } | undefined
}

type StripChildren<N> = N | string | ReadonlyArray<N>

interface StripBox<N> {
  readonly key?: string
  readonly flexDirection?: "row" | "column"
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly minWidth?: number
  readonly alignItems?: "center"
  readonly width?: number | string
  readonly children?: StripChildren<N>
}

interface StripText {
  readonly bold?: boolean
  readonly dimColor?: boolean
  readonly color?: string
  readonly wrap?: "truncate-end"
  readonly children?: string
}

interface StripButton {
  readonly key: string
  readonly label: string
  readonly hotkey: string
  readonly onPress: () => void
}

interface StripSvg {
  readonly source: string
  readonly alt: string
  readonly width: number
  readonly height: number
  readonly isInteractive: boolean
}

// The slice of every surface's element table the strip draws with; N is the
// table's element type. The terminal's has no Svg.
export interface PaneElements<N> {
  readonly Box: (props: StripBox<N>) => N
  readonly Text: (props: StripText) => N
  readonly Button: (props: StripButton) => N
  readonly Svg?: (props: StripSvg) => N
}

// Where the strip draws, `e.surface`, and the band's width.
export interface StripSite {
  readonly surface: "terminal" | "desktop" | "vscode" | "mobile"
  readonly columns: number
}

export interface StripActions {
  readonly stop: () => void
  readonly openDossier: (path: string) => void
  readonly dismiss: () => void
}

const STAGES = ["Finders", "Pool", "Verification", "Judgment"] as const
type Stage = (typeof STAGES)[number]

const STAGE_COLOR: Record<Stage, string> = {
  Finders: "#5fafff",
  Pool: "#af87ff",
  Verification: "#ffaf5f",
  Judgment: "#5fd787",
}
const SHORT: Record<Stage, string> = { Finders: "Find", Pool: "Pool", Verification: "Verify", Judgment: "Judge" }
// Each count's color on the terminal, where P3 takes the theme's warning
// color so it reads on a light background too, and in the SVG, whose markup
// has no theme.
const TALLY = {
  P1: { terminal: { color: "red", bold: true }, pill: "#e5484d" },
  P2: { terminal: { color: "#ff8700", bold: true }, pill: "#ff8700" },
  P3: { terminal: { color: "warning" }, pill: "#e0b000" },
  unranked: { terminal: { dimColor: true }, pill: "#8b8b8b" },
  clean: { terminal: { color: "green" }, pill: "#30a46c" },
} as const

// "<run>-finders-2-finder-absence" → Finders/absence.
export const stageOf = (invocationId: string): { readonly stage: Stage; readonly name: string } | undefined => {
  const finder = /-finder-([^/]+)$/.exec(invocationId)?.[1]
  if (finder !== undefined) return { stage: "Finders", name: finder }
  if (invocationId.endsWith("-pool")) return { stage: "Pool", name: "Pool" }
  const bundle = /-verification-(\d+)$/.exec(invocationId)?.[1]
  if (bundle !== undefined) return { stage: "Verification", name: `bundle ${bundle}` }
  if (invocationId.endsWith("-judgment")) return { stage: "Judgment", name: "Judgment" }
  return undefined
}

const hasEnded = (state: AgentActivity["state"]) => state === "answered" || state === "failed" || state === "stopped"

const stageRuns = (view: RunView, stage: Stage) =>
  view.activity.filter((each) => stageOf(each.invocationId)?.stage === stage)

// A stage has started once one of its agents opened, and finished once every
// one has ended. The Finders finish with their stage, whether or not one
// opened: every lens may have been skipped.
const stageState = (view: RunView, stage: Stage) => {
  const ran = stageRuns(view, stage)
  const started = ran.length > 0
  const ended = ran.every((each) => hasEnded(each.state))
  const finished = stage === "Finders"
    ? ended && (view.findersFinished || view.exitCode !== undefined)
    : started && ended
  return { started, finished }
}

const clock = (millis: number) => {
  const seconds = Math.max(0, Math.round(millis / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`

// The Finders' candidates so far.
const leads = (view: RunView) => stageRuns(view, "Finders").reduce((sum, each) => sum + (each.items ?? 0), 0)

const markOf = (state: AgentActivity["state"] | undefined): MarkState =>
  state === undefined || state === "opening" ? "waiting" : state === "stopped" ? "failed" : state

const markOrder = (state: MarkState) => (state === "answered" || state === "failed" ? 0 : state === "running" ? 1 : 2)

// Each stage's marks: one per agent, ended first, then running, then to
// start, so the row fills left to right. A Finder lens not yet invoked counts
// as one to start, by its latest attempt once it has one; a skipped lens never
// runs, so it is drawn after the rest.
const stageMarks = (view: RunView): ReadonlyArray<TrackStage> =>
  STAGES.map((stage) => {
    const ran = stageRuns(view, stage)
    const states = stage === "Finders"
      ? view.lenses.map((lens) => ran.findLast((each) => stageOf(each.invocationId)?.name === lens)?.state)
      : ran.map((each) => each.state)
    const marks = states.map(markOf).sort((a, b) => markOrder(a) - markOrder(b))
    const notRun: ReadonlyArray<MarkState> = stage === "Finders" ? view.skipped.map(() => "skipped") : []
    return { name: SHORT[stage], color: STAGE_COLOR[stage], ...stageState(view, stage), marks: [...marks, ...notRun] }
  })

// What the run is doing, in plain words, from its state.
export const doing = (view: RunView): string => {
  const finders = stageRuns(view, "Finders")
  if (!stageState(view, "Finders").finished) {
    if (finders.length === 0) return "Building the first prompt"
    if (finders.length === 1 && !hasEnded(finders[0]?.state ?? "opening")) return "Sending the first finder to set the cache"
    // A lens whose Finder has not opened yet is still to look; a retried
    // Finder counts by its latest attempt.
    const ended = view.lenses.filter((lens) => {
      const state = finders.findLast((each) => stageOf(each.invocationId)?.name === lens)?.state
      return state !== undefined && hasEnded(state)
    }).length
    const looking = plural(view.lenses.length - ended, "finder", "finders")
    const found = leads(view)
    return found === 0 ? `${looking} looking for bugs` : `${looking} still looking · ${plural(found, "lead", "leads")} so far`
  }
  const claims = view.routed?.bugClaims ?? 0
  const notes = view.routed?.observations ?? 0
  const pool = stageState(view, "Pool")
  const verification = stageState(view, "Verification")
  const judgment = stageState(view, "Judgment")
  // Verification and Judgment both wait for Pool's clusters.
  const grouped = view.routed !== undefined &&
    ((claims === 0 && notes === 0) || pool.finished || verification.started || judgment.started)
  if (!grouped) {
    return [
      ...(claims === 0 ? [] : [`Grouping ${plural(claims, "possible bug", "possible bugs")} for checking`]),
      ...(notes === 0 ? [] : [`${plural(notes, "note", "notes")} to weigh`]),
    ].join(" · ") || "Grouping the leads"
  }
  const weighing = notes > 0 && !judgment.finished
  if (claims > 0 && !verification.finished) {
    const alongside = weighing && judgment.started ? ` · weighing ${plural(notes, "note", "notes")}` : ""
    return `Double-checking ${plural(claims, "possible bug", "possible bugs")}${alongside}`
  }
  if (weighing) return `Weighing ${plural(notes, "note", "notes")}`
  return "Writing the dossier"
}

// "2 finders failed · 1 pool gap": the work missing from the dossier.
const gapText = (gaps: NonNullable<RunView["result"]>["coverageGaps"]) => {
  const counts = new Map<string, number>()
  for (const gap of gaps) counts.set(gap.stage, (counts.get(gap.stage) ?? 0) + 1)
  return [...counts].map(([stage, count]) =>
    stage === "finders" ? `${plural(count, "finder", "finders")} failed` : plural(count, `${stage} gap`, `${stage} gaps`)
  ).join(" · ")
}

interface Tally {
  readonly text: string
  readonly kind: keyof typeof TALLY
}

// The strip's reading of the run, which both layouts draw.
interface StripState {
  // A finished review's counts, or how a run with no dossier ended.
  readonly tallies: ReadonlyArray<Tally>
  readonly verdict: { readonly text: string; readonly color: string } | undefined
  // What the run is doing or found, with the lenses not run while it runs,
  // and the heading's shorter word on it.
  readonly status: string
  readonly brief: string
  readonly gaps: string
  readonly buttons: ReadonlyArray<StripButton>
  // Whether the stage row is drawn on the terminal: only while it runs.
  readonly running: boolean
}

const stripState = (view: RunView, actions: StripActions): StripState => {
  const dismiss: StripButton = { key: "dismiss", label: "Dismiss", hotkey: "d", onPress: actions.dismiss }
  if (view.result !== undefined) {
    const { coverageGaps, dossierMarkdown, entries } = view.result
    const tallies: Array<Tally> = []
    for (const priority of ["P1", "P2", "P3"] as const) {
      const count = entries.filter((entry) => entry.reviewPriority === priority).length
      if (count > 0) tallies.push({ text: `${priority} ${String(count)}`, kind: priority })
    }
    const unranked = entries.filter((entry) => entry.reviewPriority === undefined).length
    if (unranked > 0) tallies.push({ text: `${String(unranked)} unranked`, kind: "unranked" })
    if (entries.length === 0) tallies.push({ text: "no findings", kind: "clean" })
    const found = plural(entries.length, "finding", "findings")
    const status = stageRuns(view, "Finders").length === 0 ? found : `${found} from ${plural(leads(view), "lead", "leads")}`
    return {
      tallies,
      verdict: undefined,
      status,
      brief: status,
      gaps: gapText(coverageGaps),
      buttons: [{ key: "dossier", label: "Open dossier", hotkey: "o", onPress: () => actions.openDossier(dossierMarkdown) }, dismiss],
      running: false,
    }
  }
  if (view.exitCode !== undefined) {
    const status = view.refusal?.split("\n")[0] ?? "no dossier from this run"
    return {
      tallies: [],
      verdict: view.refusal === undefined ? { text: "ended", color: "yellow" } : { text: "could not review", color: "red" },
      status,
      brief: status,
      gaps: "",
      buttons: [dismiss],
      running: false,
    }
  }
  // Why a lens is not run goes after what the run is doing, so a narrow band
  // truncates it first; the heading leaves it to the drawing's marks.
  const brief = doing(view)
  return {
    tallies: [],
    verdict: undefined,
    status: view.skipped.length === 0 ? brief : `${brief} · not run: ${view.skipped.map(({ lens, reason }) => `${lens} (${reason})`).join(", ")}`,
    brief,
    gaps: "",
    buttons: [{ key: "stop", label: "Stop", hotkey: "s", onPress: actions.stop }],
    running: true,
  }
}

const postLine = <N>(view: RunView, el: PaneElements<N>) =>
  view.post === undefined || view.result === undefined
    ? []
    : [el.Text({ ...(view.post.state === "failed" ? { color: "red" } : { dimColor: true }), children: view.post.text.split("\n")[0] ?? "" })]

const terminalStrip = <N>(view: RunView, el: PaneElements<N>, width: number | string, now: number, state: StripState): N => {
  const { Box, Text } = el
  const cells: Array<N> = [Text({ color: "#d7875f", bold: true, children: "◆ Gauntlet  " })]
  state.tallies.forEach((tally, at) => {
    if (at > 0) cells.push(Text({ dimColor: true, children: " · " }))
    cells.push(Text({ ...TALLY[tally.kind].terminal, children: tally.text }))
  })
  if (state.verdict !== undefined) cells.push(Text({ color: state.verdict.color, children: state.verdict.text }))
  if (state.running) {
    // A running agent's mark blinks by swapping glyphs.
    const pulse = Math.floor(now / 500) % 2 === 0 ? "●" : "◉"
    const glyph = (mark: MarkState, color: string) => {
      switch (mark) {
        case "answered":
          return Text({ color, children: "✓" })
        case "failed":
          return Text({ color: "red", children: "✗" })
        case "running":
          return Text({ color, bold: true, children: pulse })
        case "skipped":
          return Text({ dimColor: true, children: "⊘" })
        case "waiting":
          return Text({ dimColor: true, children: "○" })
      }
    }
    stageMarks(view).forEach(({ color, finished, marks, name, started }, at) => {
      if (at > 0) cells.push(Text({ children: "  " }))
      cells.push(Text(started ? { color, bold: !finished, children: `${name} ` } : { dimColor: true, children: `${name} ` }))
      cells.push(...(marks.length === 0 ? [Text({ dimColor: true, children: "○" })] : marks.map((mark) => glyph(mark, color))))
    })
  }
  return Box({
    flexDirection: "column",
    width,
    children: [
      Box({
        flexDirection: "row",
        width,
        alignItems: "center",
        children: [Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", children: cells }), ...state.buttons.map(el.Button)],
      }),
      Box({
        flexDirection: "row",
        width,
        children: [
          Text({ dimColor: true, wrap: "truncate-end", children: `${clock((view.endedAt ?? now) - view.startedAt)} · ${state.status}` }),
          ...(state.gaps === "" ? [] : [Text({ color: "yellow", wrap: "truncate-end", children: ` · ${state.gaps}` })]),
        ],
      }),
      // The post's outcome has a line of its own and wraps: a failure's tail
      // names the run to deliver again, and the strip is where it is said.
      ...postLine(view, el),
    ],
  })
}

// Off the terminal: the heading, what the run is doing and the buttons on one
// line, centred on one another, and the drawing under them, at every stage of
// the run, so the layout never changes as it ends.
const drawnStrip = <N>(view: RunView, el: PaneElements<N>, svg: (props: StripSvg) => N, now: number, state: StripState): N => {
  const { Box, Text } = el
  const age = { now, seconds: Math.max(0, ((view.endedAt ?? now) - view.startedAt) / 1000), running: view.exitCode === undefined }
  const pills = state.tallies.map((tally) => ({ text: tally.text, color: TALLY[tally.kind].pill }))
  return Box({
    flexDirection: "column",
    width: "100%",
    children: [
      Box({
        flexDirection: "row",
        width: "100%",
        alignItems: "center",
        children: [
          Box({
            flexGrow: 1,
            flexShrink: 1,
            minWidth: 0,
            flexDirection: "row",
            alignItems: "center",
            children: [
              // The heading keeps its width; what the run is doing truncates.
              Box({ flexShrink: 0, children: Text({ color: "#d7875f", bold: true, children: "◆ Gauntlet" }) }),
              ...(state.verdict === undefined ? [] : [Text({ color: state.verdict.color, children: ` · ${state.verdict.text}` })]),
              Text({ dimColor: true, wrap: "truncate-end", children: ` · ${state.brief}` }),
              ...(state.gaps === "" ? [] : [Text({ color: "yellow", wrap: "truncate-end", children: ` · ${state.gaps}` })]),
            ],
          }),
          ...state.buttons.map(el.Button),
        ],
      }),
      // An image, not a frame: a frame blanks while each redraw's copy loads.
      svg({ ...trackSvg(stageMarks(view), pills, age), alt: `Gauntlet: ${state.brief}`, isInteractive: false }),
      ...postLine(view, el),
    ],
  })
}

export const renderStrip = <N>(
  view: RunView,
  el: PaneElements<N>,
  site: StripSite,
  now: number,
  actions: StripActions,
): N => {
  const state = stripState(view, actions)
  // The terminal lays the band out in cells; elsewhere text is proportional,
  // so a count of cells is no width there, and the stage row is a drawing.
  return site.surface === "terminal" || el.Svg === undefined
    ? terminalStrip(view, el, site.surface === "terminal" ? site.columns : "100%", now, state)
    : drawnStrip(view, el, el.Svg, now, state)
}
