import type { EngineInterface, Register } from "claude-code"
import {
  type Finding,
  type Fixture,
  drawOn,
  nowAt,
  renderBand,
  renderCard,
  renderReportHtml,
  renderDock,
  renderFindings,
  renderProgress,
  renderRunPane,
  renderStrip,
  renderTimeline,
  viewAt,
} from "./vendor/viz.js"

// viz-lab's hooks: `/viz <variant> [seconds | play [speed]]` draws one
// prototype view of a replayed review (hooks/fixture.json). No model turn
// runs: the command answers itself.

const PANE = "viz-lab"
const VARIANTS = ["progress", "strip", "run", "side", "band", "findings", "timeline", "card", "off"] as const
type Variant = (typeof VARIANTS)[number]

let fixture: Fixture | undefined
let variant: Variant = "off"
let fixedAt = 0
let playFrom: number | undefined
let speed = 1
let selected = 0
let tick: { readonly cancel: () => void } | undefined

const at = () => {
  const end = fixture?.endedAt ?? 0
  return playFrom === undefined ? Math.min(fixedAt, end + 1) : Math.min((Date.now() - playFrom) * speed, end + 1)
}

function fix($: EngineInterface, finding: Finding) {
  void $.prompt.fill({
    text: `Fix the Gauntlet finding at ${finding.file}:${finding.line} (${finding.priority}, ${finding.verdict}): ${finding.summary}`,
    mode: "replace",
  })
}

async function openReport($: EngineInterface, fx: Fixture) {
  const path = `${(await $.env.get("TMPDIR")) ?? "/tmp/"}gauntlet-report-${fx.runId.slice(-4)}.html`
  await $.fs.write(path, renderReportHtml(fx))
  await $.process.run(["open", path])
  $.ui.toast(`report opened: ${path}`)
}

async function show($: EngineInterface, args: string) {
  const [name = "run", when, rate] = args.trim().split(/\s+/)
  if (!(VARIANTS as ReadonlyArray<string>).includes(name)) return { text: `unknown variant ${name}` }
  variant = name as Variant
  tick?.cancel()
  tick = undefined
  playFrom = undefined
  if (when === "play") {
    playFrom = Date.now()
    speed = Number(rate ?? "1") || 1
    tick = $.clock.every(250, () => {
      $.ui.invalidate("ui.render")
      if (at() > (fixture?.endedAt ?? 0)) {
        tick?.cancel()
        tick = undefined
      }
    })
  } else {
    fixedAt = when === undefined ? (fixture?.endedAt ?? 0) + 1 : Number(when) * 1000
  }
  if (variant === "off" || variant === "band" || variant === "strip" || variant === "card") await $.ui.close({ id: PANE })
  else {
    const opened = await $.ui.open({ id: PANE, title: `viz: ${variant}`, closeOnEscape: true, ...(variant === "side" || variant === "progress" ? { columns: 72 } : { rows: 24 }) })
    if (!opened.isPlaced) return { text: `pane not placed: ${opened.reason}` }
  }
  $.ui.invalidate("ui.render")
  if (variant === "card") return { text: fixture?.result ?? "" }
  return { text: `${variant} at ${when ?? "end"}` }
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    fixture = JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/fixture.json`)) as Fixture
    // A control file Claude writes to switch the view without typing:
    // `echo "side 60" > ~/.gauntlet/viz-view.txt` runs `/viz side 60` in every
    // session with gc-viz loaded, and again after each reload restores it.
    const control = `${(await $.env.get("HOME")) ?? ""}/.gauntlet/viz-view.txt`
    let seen: string | undefined
    $.clock.every(500, () => {
      void $.fs.read(control).then(
        (text) => {
          const args = text.trim()
          if (args === seen) return
          seen = args
          if (args !== "") void show($, args)
        },
        () => undefined,
      )
    })
    await $.command.register({ name: "viz", description: "viz-lab: /viz <progress|strip|run|side|band|findings|timeline|card|off> [seconds|play [speed]]" })
    await $.tool.register({
      name: "viz_show",
      description: "Show one viz-lab view of the replayed Gauntlet review in this app, to screenshot it. variant: progress|strip|run|side|band|findings|timeline|card|off. at: seconds into the run to freeze at (default: the end), or \"play\" to replay at `speed`.",
      inputSchema: { type: "object", properties: { variant: { type: "string" }, at: { type: "string" }, speed: { type: "number" } }, required: ["variant"] },
    })
    return started
  })

  on("command.run", { command: "viz" }, ($, e) => show($, e.args))

  // The same views for the model: Claude calls this to look at a view itself
  // (a tool call reloads an edited mod first), then screenshots the app.
  on("tool.call", { tool: "mcp__gc-viz__viz_show" }, async ($, e) => {
    const { variant: name = "side", at: when, speed: rate } = e as unknown as { variant?: string; at?: string; speed?: number }
    const { text } = await show($, [name, when ?? "", when === "play" && rate !== undefined ? String(rate) : ""].join(" "))
    return { result: text }
  })

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e, next) => {
    if (fixture === undefined) return next(e)
    drawOn(e.surface)
    const el = $.ui.resolve(e) as never
    const t = at()
    const view = viewAt(fixture, t)
    const width = e.props.bodyColumns
    const close = () => {
      variant = "off"
      void $.ui.close({ id: PANE })
    }
    const select = (index: number) => {
      selected = index
      $.ui.invalidate("ui.render")
    }
    switch (variant) {
      case "progress":
        return renderProgress(view, fixture, el, width, nowAt(t), { stop: close, close, dossier: () => void openReport($, fixture) })
      case "side":
        return renderDock(view, fixture, el, width, nowAt(t), selected, { stop: close, close, select, fix: (f) => fix($, f) })
      case "findings":
        return renderFindings(fixture, el, width, selected, { select, fix: (f) => fix($, f), report: () => void openReport($, fixture), close })
      case "timeline":
        return renderTimeline(fixture, view, el, width, t, e.surface)
      default:
        return renderRunPane(view, el, width, nowAt(t), { stop: close, close })
    }
  })

  on("ui.render", { component: "CommandOutput" }, ($, e, next) => {
    if (e.props.command !== "viz" || !e.props.args.startsWith("card") || fixture === undefined) return next(e)
    return renderCard(fixture, $.ui.resolve(e) as never, (e.viewport?.columns ?? 100) - 6)
  })

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    drawOn(e.surface)
    if (variant === "strip" && fixture !== undefined && !e.props.hasSurvey) {
      const t = at()
      return renderStrip(viewAt(fixture, t), fixture, $.ui.resolve(e) as never, nowAt(t), {
        dossier: () => void openReport($, fixture),
        dismiss: () => {
          variant = "off"
          $.ui.invalidate("ui.render")
        },
      })
    }
    if (variant !== "band" || fixture === undefined || e.props.hasSurvey) return next(e)
    const t = at()
    return renderBand(viewAt(fixture, t), fixture, $.ui.resolve(e) as never, e.props.bodyColumns, nowAt(t), {
      open: () => {
        variant = "findings"
        void $.ui.open({ id: PANE, title: "viz: findings", closeOnEscape: true, rows: 24 })
      },
      dismiss: () => {
        variant = "off"
        $.ui.invalidate("ui.render")
      },
    })
  })
}
