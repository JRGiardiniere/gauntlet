// gc-cli's run pane: what a review in flight looks like, drawn by the
// hooks module's `ui.render` hook for its Pane. The view is plain data the
// engine assembles from its agent driver and the CLI's progress lines; the
// tree is drawn with the elements every surface carries (Box, Text, Button),
// so the terminal, desktop, VS Code and mobile all draw the same pane.
import type { AgentActivity } from "./agents.ts"

export interface RunView {
  readonly argv: ReadonlyArray<string>
  readonly runId: string | undefined
  readonly startedAt: number
  readonly endedAt: number | undefined
  // The Finders the run loads, from its "loading … Lenses" line; a Finder
  // that never opens by the end of the Finder stage was not runnable.
  readonly lenses: ReadonlyArray<string>
  readonly findersFinished: boolean
  readonly activity: ReadonlyArray<AgentActivity>
  // The latest progress line worth showing.
  readonly latest: string | undefined
  readonly exitCode: number | undefined
}

type PaneChildren<N> = N | string | ReadonlyArray<N>

interface PaneBox<N> {
  readonly key?: string
  readonly flexDirection?: "row" | "column"
  readonly flexGrow?: number
  readonly flexShrink?: number
  readonly justifyContent?: "flex-end"
  readonly width?: number
  readonly children?: PaneChildren<N>
}

interface PaneText {
  readonly bold?: boolean
  readonly dimColor?: boolean
  readonly color?: string
  readonly wrap?: "truncate-end"
  readonly children?: string
}

interface PaneButton {
  readonly key: string
  readonly label: string
  readonly hotkey: string
  readonly onPress: () => void
}

// The slice of every surface's element table the pane draws with; N is the
// table's element type.
export interface PaneElements<N> {
  readonly Box: (props: PaneBox<N>) => N
  readonly Text: (props: PaneText) => N
  readonly Button: (props: PaneButton) => N
}

export interface PaneActions {
  readonly stop: () => void
  readonly close: () => void
}

type Stage = "Finders" | "Pool" | "Verification" | "Judgment"

interface Row {
  readonly stage: Stage
  readonly name: string
  readonly activity: AgentActivity | undefined
}

// "<run>-finders-2-finder-absence" → Finders/absence.
export const rowOf = (invocationId: string): Omit<Row, "activity"> | undefined => {
  const finder = /-finder-([^/]+)$/.exec(invocationId)?.[1]
  if (finder !== undefined) return { stage: "Finders", name: finder }
  if (invocationId.endsWith("-pool")) return { stage: "Pool", name: "Pool" }
  const bundle = /-verification-(\d+)$/.exec(invocationId)?.[1]
  if (bundle !== undefined) return { stage: "Verification", name: `bundle ${bundle}` }
  if (invocationId.endsWith("-judgment")) return { stage: "Judgment", name: "Judgment" }
  return undefined
}

export const paneRows = (view: RunView): ReadonlyArray<Row> => {
  const rows: Array<Row> = view.lenses.map((lens) => ({ stage: "Finders", name: lens, activity: undefined }))
  for (const activity of view.activity) {
    const row = rowOf(activity.invocationId)
    if (row === undefined) continue
    const at = rows.findIndex((each) => each.stage === row.stage && each.name === row.name)
    if (at === -1) rows.push({ ...row, activity })
    else rows[at] = { ...row, activity }
  }
  const order: ReadonlyArray<Stage> = ["Finders", "Pool", "Verification", "Judgment"]
  return order.flatMap((stage) => rows.filter((row) => row.stage === stage))
}

const clock = (millis: number) => {
  const seconds = Math.max(0, Math.round(millis / 1000))
  return `${String(Math.floor(seconds / 60))}:${String(seconds % 60).padStart(2, "0")}`
}

const kilo = (count: number) =>
  count >= 1_000_000 ? `${(count / 1_000_000).toFixed(1)}M` : count >= 1000 ? `${String(Math.round(count / 1000))}K` : String(count)

type Tokens = AgentActivity["tokens"]

const tokenText = (tokens: Tokens) => {
  const prompt = tokens.input + tokens.cacheRead + tokens.cacheWrite
  if (prompt === 0) return ""
  return `${kilo(prompt)} in (${String(Math.round((tokens.cacheRead / prompt) * 100))}% cached) · ${kilo(tokens.output)} out`
}

const sum = (activity: ReadonlyArray<AgentActivity>): Tokens =>
  activity.reduce(
    (total, each) => ({
      input: total.input + each.tokens.input,
      output: total.output + each.tokens.output,
      cacheRead: total.cacheRead + each.tokens.cacheRead,
      cacheWrite: total.cacheWrite + each.tokens.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  )

const itemNoun: Record<Stage, string> = { Finders: "found", Pool: "clusters", Verification: "verdicts", Judgment: "decisions" }

interface RowLook {
  readonly mark: string
  readonly color: string | undefined
  readonly detail: string
  readonly time: string
}

const lookOf = (row: Row, view: RunView, now: number): RowLook => {
  const activity = row.activity
  if (activity === undefined) {
    return view.findersFinished || view.endedAt !== undefined
      ? { mark: "–", color: undefined, detail: "not run", time: "" }
      : { mark: "○", color: undefined, detail: "not started", time: "" }
  }
  const since = activity.spawnedAt
  const took = since === undefined ? "" : clock((activity.endedAt ?? view.endedAt ?? now) - since)
  const calls = activity.toolCalls === 0 ? "" : ` · ${String(activity.toolCalls)} calls`
  switch (activity.state) {
    case "opening":
      return { mark: "○", color: undefined, detail: "starting", time: "" }
    case "waiting":
      return { mark: "○", color: "yellow", detail: "waiting for an agent slot", time: "" }
    case "running":
      return {
        mark: "●",
        color: "cyan",
        detail: `${activity.lastTool ?? (activity.turns > 0 ? "correcting its emit" : "reading the diff")}${calls}`,
        time: took,
      }
    case "answered":
      return {
        mark: "✓",
        color: "green",
        detail: [activity.items === undefined ? "no emit" : `${String(activity.items)} ${itemNoun[row.stage]}`, tokenText(activity.tokens)]
          .filter((part) => part !== "")
          .join(" · "),
        time: took,
      }
    case "failed":
      return { mark: "✗", color: "red", detail: `failed${calls}`, time: took }
    case "stopped":
      return { mark: "■", color: "yellow", detail: `stopped${calls}`, time: took }
  }
}

export const renderRunPane = <N>(
  view: RunView | undefined,
  el: PaneElements<N>,
  width: number,
  now: number,
  actions: PaneActions,
): N => {
  const Box = (props: PaneBox<N>) => el.Box(props)
  const Text = (props: PaneText) => el.Text(props)
  const Button = (props: PaneButton) => el.Button(props)
  if (view === undefined) {
    return Box({
      flexDirection: "row",
      width,
      children: [
        Box({ flexGrow: 1, children: [Text({ dimColor: true, children: "No review in this session yet. Run /gc-cli [target]." })] }),
        Button({ key: "close", label: "Close", hotkey: "c", onPress: actions.close }),
      ],
    })
  }
  const rows = paneRows(view)
  const live = view.activity.filter((each) => each.state === "running").length
  const target = view.argv.slice(1).filter((word) => !word.startsWith("--related-files")).join(" ")
  const status = view.exitCode === undefined
    ? `running · ${String(live)} live`
    : view.exitCode === 0 ? "finished" : `ended (exit ${String(view.exitCode)})`
  const header = [target, view.runId?.replace(/^.*-/, "run ") ?? "", clock((view.endedAt ?? now) - view.startedAt), status]
    .filter((part) => part !== "")
    .join(" · ")
  const lines: Array<{ readonly key: string; readonly name: string; readonly look: RowLook }> = []
  const headings: Array<{ readonly before: number; readonly text: string }> = []
  for (const stage of ["Finders", "Pool", "Verification", "Judgment"] as const) {
    const inStage = rows.filter((row) => row.stage === stage)
    const looks = inStage.map((row) => ({ row, look: lookOf(row, view, now) }))
    if (looks.length === 1) {
      const [{ look, row }] = looks
      lines.push({ key: stage, name: stage === "Finders" ? row.name : stage, look })
      continue
    }
    if (looks.length === 0) continue
    const ran = inStage.flatMap((row) => (row.activity === undefined ? [] : [row.activity]))
    const done = ran.filter((activity) => activity.state === "answered").length
    const count = `${stage} ${String(done)}/${String(inStage.length)}`
    // A stage whose agents have all ended is one summary row.
    if (looks.every(({ look }) => look.mark !== "●" && look.mark !== "○")) {
      const failed = looks.some(({ look }) => look.mark === "✗")
      const stopped = looks.some(({ look }) => look.mark === "■")
      const items = ran.reduce((total, activity) => total + (activity.items ?? 0), 0)
      const starts = ran.flatMap((activity) => (activity.spawnedAt === undefined ? [] : [activity.spawnedAt]))
      const ends = ran.flatMap((activity) => (activity.endedAt === undefined ? [] : [activity.endedAt]))
      const notRun = inStage.length - ran.length
      lines.push({
        key: stage,
        name: stage,
        look: {
          mark: failed ? "✗" : stopped ? "■" : "✓",
          color: failed ? "red" : stopped ? "yellow" : "green",
          detail: [
            `${String(ran.length)} ran`,
            notRun === 0 ? "" : `${String(notRun)} not run`,
            `${String(items)} ${itemNoun[stage]}`,
            tokenText(sum(ran)),
          ].filter((part) => part !== "").join(" · "),
          time: starts.length === 0 || ends.length === 0 ? "" : clock(Math.max(...ends) - Math.min(...starts)),
        },
      })
      continue
    }
    headings.push({ before: lines.length, text: count })
    for (const { look, row } of looks) lines.push({ key: `${stage}-${row.name}`, name: row.name, look })
  }
  const nameWidth = Math.min(26, Math.max(12, ...lines.map((line) => line.name.length + 1)))
  const children: Array<N> = [
    Box({
      flexDirection: "row",
      width,
      children: [
        Box({ flexGrow: 1, flexShrink: 1, children: [Text({ bold: true, wrap: "truncate-end", children: header })] }),
        view.exitCode === undefined
          ? Button({ key: "stop", label: "Stop review", hotkey: "s", onPress: actions.stop })
          : Button({ key: "close", label: "Close", hotkey: "c", onPress: actions.close }),
      ],
    }),
  ]
  lines.forEach((line, at) => {
    for (const heading of headings) {
      if (heading.before === at) children.push(Text({ bold: true, children: heading.text }))
    }
    const { look } = line
    children.push(
      Box({
        key: line.key,
        flexDirection: "row",
        width,
        children: [
          Box({ width: 2, flexShrink: 0, children: [Text(look.color === undefined ? { dimColor: true, children: look.mark } : { color: look.color, children: look.mark })] }),
          Box({ width: nameWidth, flexShrink: 0, children: [Text({ wrap: "truncate-end", children: line.name })] }),
          Box({ flexGrow: 1, flexShrink: 1, children: [Text({ dimColor: look.mark !== "●", wrap: "truncate-end", children: look.detail })] }),
          Box({ width: 7, flexShrink: 0, justifyContent: "flex-end", children: [Text({ dimColor: true, children: look.time })] }),
        ],
      }),
    )
  })
  const tokens = tokenText(sum(view.activity))
  if (tokens !== "") children.push(Text({ dimColor: true, wrap: "truncate-end", children: `Tokens: ${tokens}` }))
  if (view.latest !== undefined) {
    children.push(Text({ dimColor: true, wrap: "truncate-end", children: view.latest.replace(/^gauntlet: /, "") }))
  }
  return Box({ flexDirection: "column", children })
}
