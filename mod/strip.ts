// The Mod's strip: a review in flight, drawn above the prompt by the hooks
// module's `ui.render` hook on `AbovePrompt`. Line 1 is each stage with one
// mark per agent; line 2, always there, is the elapsed time and what the run
// is doing in plain words. Once the dossier is written, line 1 is its Review
// Priority counts with Open dossier and Dismiss. Counts come from the Run's
// milestones and the agent driver's activity, never from progress text; no
// dollar or cache figure shows.
import type { RunMilestone } from "../src/run/run-milestones.ts"
import type { AgentActivity } from "./agents.ts"

export interface RunView {
  readonly startedAt: number
  readonly endedAt: number | undefined
  // The Finders the run's plan froze, from Started.
  readonly lenses: ReadonlyArray<string>
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

// The slice of every surface's element table the strip draws with; N is the
// table's element type.
export interface PaneElements<N> {
  readonly Box: (props: StripBox<N>) => N
  readonly Text: (props: StripText) => N
  readonly Button: (props: StripButton) => N
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
const PRIORITY_COLOR = { P1: "red", P2: "#ff8700", P3: "#878787" } as const

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
// one has ended (and, for the Finders, the stage itself has).
const stageState = (view: RunView, stage: Stage) => {
  const ran = stageRuns(view, stage)
  const started = ran.length > 0
  const finished = started && ran.every((each) => hasEnded(each.state)) &&
    (stage !== "Finders" || view.findersFinished || view.exitCode !== undefined)
  return { started, finished }
}

const clock = (millis: number) => {
  const seconds = Math.max(0, Math.round(millis / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`
}

const plural = (count: number, one: string, many: string) => `${String(count)} ${count === 1 ? one : many}`

// The Finders' candidates so far.
const leads = (view: RunView) => stageRuns(view, "Finders").reduce((sum, each) => sum + (each.items ?? 0), 0)

// What the run is doing, in plain words, from its state.
export const doing = (view: RunView): string => {
  const finders = stageRuns(view, "Finders")
  if (finders.length === 0) return "Building the first prompt"
  if (!stageState(view, "Finders").finished) {
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
  // so a count of cells is no width there.
  const width = site.surface === "terminal" ? site.columns : "100%"
  const ended = view.exitCode !== undefined
  const elapsed = clock((view.endedAt ?? now) - view.startedAt)
  const cells: Array<N> = [Text({ color: "#d7875f", bold: true, children: "◆ Gauntlet  " })]
  const buttons: Array<N> = []
  let status: string
  let gaps = ""
  if (view.result !== undefined) {
    const { coverageGaps, dossierMarkdown, entries } = view.result
    for (const priority of ["P1", "P2", "P3"] as const) {
      const count = entries.filter((entry) => entry.reviewPriority === priority).length
      if (count === 0) continue
      if (cells.length > 1) cells.push(Text({ dimColor: true, children: " · " }))
      cells.push(Text({ color: PRIORITY_COLOR[priority], bold: priority !== "P3", children: `${priority} ${String(count)}` }))
    }
    const unranked = entries.filter((entry) => entry.reviewPriority === undefined).length
    if (unranked > 0) cells.push(Text({ dimColor: true, children: `${cells.length > 1 ? " · " : ""}${String(unranked)} unranked` }))
    if (entries.length === 0) cells.push(Text({ color: "green", children: "no findings" }))
    buttons.push(
      Button({ key: "dossier", label: "Open dossier", hotkey: "o", onPress: () => actions.openDossier(dossierMarkdown) }),
      Button({ key: "dismiss", label: "Dismiss", hotkey: "d", onPress: actions.dismiss }),
    )
    const found = plural(entries.length, "finding", "findings")
    status = stageRuns(view, "Finders").length === 0 ? found : `${found} from ${plural(leads(view), "lead", "leads")}`
    gaps = gapText(coverageGaps)
  } else if (ended) {
    cells.push(view.refusal === undefined ? Text({ color: "yellow", children: "ended" }) : Text({ color: "red", children: "could not review" }))
    buttons.push(Button({ key: "dismiss", label: "Dismiss", hotkey: "d", onPress: actions.dismiss }))
    status = view.refusal?.split("\n")[0] ?? "no dossier from this run"
  } else {
    const pulse = Math.floor(now / 500) % 2 === 0 ? "●" : "◉"
    STAGES.forEach((stage, at) => {
      const { finished, started } = stageState(view, stage)
      const color = STAGE_COLOR[stage]
      if (at > 0) cells.push(Text({ children: "  " }))
      cells.push(Text(started ? { color, bold: !finished, children: `${SHORT[stage]} ` } : { dimColor: true, children: `${SHORT[stage]} ` }))
      const ran = stageRuns(view, stage)
      // A Finder lens not yet invoked counts as one to start.
      const states = stage === "Finders"
        ? view.lenses.map((lens) => ran.findLast((each) => stageOf(each.invocationId)?.name === lens)?.state)
        : ran.map((each) => each.state)
      if (states.length === 0) {
        cells.push(Text({ dimColor: true, children: "○" }))
        return
      }
      // Ended first, then running, then to start: the row fills left to right.
      const order = (state: AgentActivity["state"] | undefined) =>
        state !== undefined && hasEnded(state) ? 0 : state === "running" ? 1 : 2
      for (const state of [...states].sort((a, b) => order(a) - order(b))) {
        cells.push(
          state === "answered"
            ? Text({ color, children: "✓" })
            : state === "failed" || state === "stopped"
            ? Text({ color: "red", children: "✗" })
            : state === "running"
            ? Text({ color, bold: true, children: pulse })
            : Text({ dimColor: true, children: "○" }),
        )
      }
    })
    buttons.push(Button({ key: "stop", label: "Stop", hotkey: "s", onPress: actions.stop }))
    status = doing(view)
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
          Text({ dimColor: true, wrap: "truncate-end", children: `${elapsed} · ${status}` }),
          ...(gaps === "" ? [] : [Text({ color: "yellow", wrap: "truncate-end", children: ` · ${gaps}` })]),
        ],
      }),
    ],
  })
}
