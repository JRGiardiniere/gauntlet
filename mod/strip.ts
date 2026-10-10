// The Mod's strip: a review in flight, drawn above the prompt by the hooks
// module's `ui.render` hook on `AbovePrompt`. Line 1 is each stage with one
// mark per agent, and one per lens skipped by design, as text on the
// terminal and as one SVG (mod/strip-svg.ts) where text is proportional; line 2, always there,
// is the elapsed time and what the run is doing in plain words. Once the dossier is written, line 1 is its Review
// Priority counts with Open dossier and Dismiss, and a pull-request review's
// post adds a last line, wrapped: posting, then where it landed or why it did
// not. Counts come from the Run's
// milestones and the invocations' activity (mod/activity.ts), never from progress text; no
// dollar or cache figure shows.
import type { RunMilestone, SkippedLens } from "../src/run/run-milestones.ts"
import type { AgentActivity } from "./activity.ts"
import { type MarkState, type TrackMark, type TrackPill, type TrackStage, trackSvg } from "./strip-svg.ts"

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

// Where the strip draws: `e.surface`, never what the element table holds
// (the terminal's carries an Svg it draws as nothing), and the band's width.
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
const NOUN: Record<Stage, readonly [string, string]> = {
  Finders: ["lead", "leads"],
  Pool: ["group", "groups"],
  Verification: ["verdict", "verdicts"],
  Judgment: ["decision", "decisions"],
}
const PRIORITY_COLOR = { P1: "red", P2: "#ff8700", P3: "#878787" } as const
// The SVG's own palette: a hex for every color, as the markup has no theme.
const PILL_COLOR = { P1: "#e5484d", P2: "#ff8700", P3: "#8b8b8b", unranked: "#8b8b8b", clean: "#30a46c" } as const

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

// What one agent's mark says on hover.
const markLabel = (stage: Stage, name: string, run: AgentActivity | undefined) => {
  if (run === undefined || run.state === "opening") return `${name}: waiting`
  if (run.state === "running") return `${name}: ${stage === "Finders" ? "looking" : "working"}`
  if (run.state === "answered") return run.items === undefined ? `${name}: done` : `${name}: ${plural(run.items, ...NOUN[stage])}`
  return `${name}: ${run.state}`
}

// Each stage's marks: one per agent, ended first, then running, then to
// start, so the row fills left to right. A Finder lens not yet invoked counts
// as one to start, by its latest attempt once it has one; a skipped lens never
// runs, so it is drawn after the rest.
const stageMarks = (view: RunView): ReadonlyArray<TrackStage> =>
  STAGES.map((stage) => {
    const ran = stageRuns(view, stage)
    const agents = stage === "Finders"
      ? view.lenses.map((lens) => ({ name: lens, run: ran.findLast((each) => stageOf(each.invocationId)?.name === lens) }))
      : ran.map((run) => ({ name: stageOf(run.invocationId)?.name ?? stage, run }))
    const marks: Array<TrackMark> = agents
      .map(({ name, run }) => ({ state: markOf(run?.state), label: markLabel(stage, name, run) }))
      .sort((a, b) => markOrder(a.state) - markOrder(b.state))
    const notRun: ReadonlyArray<TrackMark> = stage === "Finders"
      ? view.skipped.map(({ lens, reason }) => ({ state: "skipped", label: `${lens}: not run (${reason})` }))
      : []
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

export const renderStrip = <N>(
  view: RunView,
  el: PaneElements<N>,
  site: StripSite,
  now: number,
  actions: StripActions,
): N => {
  const Box = (props: StripBox<N>) => el.Box(props)
  const Text = (props: StripText) => el.Text(props)
  const Button = (props: StripButton) => el.Button(props)
  // The terminal lays the band out in cells; elsewhere text is proportional,
  // so a count of cells is no width there, and the stage row is a drawing.
  const width = site.surface === "terminal" ? site.columns : "100%"
  const drawn = site.surface === "terminal" ? undefined : el.Svg
  // The drawing turns its own clock, so the line under it leaves it out.
  const age = { now, seconds: Math.max(0, ((view.endedAt ?? now) - view.startedAt) / 1000), running: view.exitCode === undefined }
  let clocked = true
  const track = (pills: ReadonlyArray<TrackPill>, alt: string) => {
    if (drawn === undefined) return undefined
    clocked = false
    // An image, not a frame: a frame blanks while each redraw's copy loads.
    return drawn({ ...trackSvg(stageMarks(view), pills, age), alt, isInteractive: false })
  }
  const ended = view.exitCode !== undefined
  const elapsed = clock((view.endedAt ?? now) - view.startedAt)
  const cells: Array<N> = [Text({ color: "#d7875f", bold: true, children: "◆ Gauntlet  " })]
  const buttons: Array<N> = []
  let status: string
  let gaps = ""
  if (view.result !== undefined) {
    const { coverageGaps, dossierMarkdown, entries } = view.result
    const pills: Array<TrackPill> = []
    for (const priority of ["P1", "P2", "P3"] as const) {
      const count = entries.filter((entry) => entry.reviewPriority === priority).length
      if (count === 0) continue
      pills.push({ text: `${priority} ${String(count)}`, color: PILL_COLOR[priority] })
      if (cells.length > 1) cells.push(Text({ dimColor: true, children: " · " }))
      cells.push(Text({ color: PRIORITY_COLOR[priority], bold: priority !== "P3", children: `${priority} ${String(count)}` }))
    }
    const unranked = entries.filter((entry) => entry.reviewPriority === undefined).length
    if (unranked > 0) {
      pills.push({ text: `${String(unranked)} unranked`, color: PILL_COLOR.unranked })
      cells.push(Text({ dimColor: true, children: `${cells.length > 1 ? " · " : ""}${String(unranked)} unranked` }))
    }
    if (entries.length === 0) {
      pills.push({ text: "no findings", color: PILL_COLOR.clean })
      cells.push(Text({ color: "green", children: "no findings" }))
    }
    buttons.push(
      Button({ key: "dossier", label: "Open dossier", hotkey: "o", onPress: () => actions.openDossier(dossierMarkdown) }),
      Button({ key: "dismiss", label: "Dismiss", hotkey: "d", onPress: actions.dismiss }),
    )
    const found = plural(entries.length, "finding", "findings")
    status = stageRuns(view, "Finders").length === 0 ? found : `${found} from ${plural(leads(view), "lead", "leads")}`
    gaps = gapText(coverageGaps)
    const drawing = track(pills, `${pills.map((pill) => pill.text).join(", ")}: ${status}`)
    if (drawing !== undefined) cells.splice(1, cells.length - 1, drawing)
  } else if (ended) {
    cells.push(view.refusal === undefined ? Text({ color: "yellow", children: "ended" }) : Text({ color: "red", children: "could not review" }))
    buttons.push(Button({ key: "dismiss", label: "Dismiss", hotkey: "d", onPress: actions.dismiss }))
    status = view.refusal?.split("\n")[0] ?? "no dossier from this run"
  } else {
    // A running agent's mark blinks. The terminal swaps glyphs; elsewhere the
    // text is proportional, the two glyphs differ in width and the row would
    // shift each blink, so the one glyph dims instead.
    const lit = Math.floor(now / 500) % 2 === 0
    const pulse = (color: string) =>
      site.surface === "terminal"
        ? Text({ color, bold: true, children: lit ? "●" : "◉" })
        : Text({ color, bold: lit, dimColor: !lit, children: "●" })
    const glyph = (state: MarkState, color: string) => {
      switch (state) {
        case "answered":
          return Text({ color, children: "✓" })
        case "failed":
          return Text({ color: "red", children: "✗" })
        case "running":
          return pulse(color)
        case "skipped":
          return Text({ dimColor: true, children: "⊘" })
        case "waiting":
          return Text({ dimColor: true, children: "○" })
      }
    }
    const drawing = track([], doing(view))
    if (drawing !== undefined) cells.push(drawing)
    else {
      stageMarks(view).forEach(({ color, finished, marks, name, started }, at) => {
        if (at > 0) cells.push(Text({ children: "  " }))
        cells.push(Text(started ? { color, bold: !finished, children: `${name} ` } : { dimColor: true, children: `${name} ` }))
        cells.push(...(marks.length === 0 ? [Text({ dimColor: true, children: "○" })] : marks.map((mark) => glyph(mark.state, color))))
      })
    }
    buttons.push(Button({ key: "stop", label: "Stop", hotkey: "s", onPress: actions.stop }))
    // Why a lens is not run goes after what the run is doing, so a narrow
    // band truncates it first.
    status = view.skipped.length === 0
      ? doing(view)
      : `${doing(view)} · not run: ${view.skipped.map(({ lens, reason }) => `${lens} (${reason})`).join(", ")}`
  }
  return Box({
    flexDirection: "column",
    width,
    children: [
      Box({
        flexDirection: "row",
        width,
        alignItems: "center",
        children: [Box({ flexGrow: 1, flexShrink: 1, minWidth: 0, flexDirection: "row", alignItems: "center", children: cells }), ...buttons],
      }),
      Box({
        flexDirection: "row",
        width,
        children: [
          Text({ dimColor: true, wrap: "truncate-end", children: clocked ? `${elapsed} · ${status}` : status }),
          ...(gaps === "" ? [] : [Text({ color: "yellow", wrap: "truncate-end", children: ` · ${gaps}` })]),
        ],
      }),
      // The post's outcome has a line of its own and wraps: a failure's tail
      // names the run to deliver again, and the strip is where it is said.
      ...(view.post === undefined || view.result === undefined
        ? []
        : [Text({ ...(view.post.state === "failed" ? { color: "red" } : { dimColor: true }), children: view.post.text.split("\n")[0] ?? "" })]),
    ],
  })
}
