import type { EngineInterface, Register } from "claude-code"
import {
  type Finding,
  type Fixture,
  nowAt,
  renderBand,
  renderCard,
  renderReportHtml,
  renderDock,
  renderFindings,
  renderRunPane,
  renderTimeline,
  viewAt,
} from "./vendor/viz.js"

// viz-lab's hooks: `/viz <variant> [seconds | play [speed]]` draws one
// prototype view of a replayed review (hooks/fixture.json). No model turn
// runs: the command answers itself.

const PANE = "viz-lab"
const VARIANTS = ["run", "side", "band", "findings", "timeline", "card", "off"] as const
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

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    fixture = JSON.parse(await $.fs.read(`${$.plugin.root}/hooks/fixture.json`)) as Fixture
    await $.command.register({ name: "viz", description: "viz-lab: /viz <run|side|band|findings|timeline|card|off> [seconds|play [speed]]" })
    return started
  })

  on("command.run", { command: "viz" }, async ($, e) => {
    const [name = "run", when, rate] = e.args.trim().split(/\s+/)
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
    if (variant === "off" || variant === "band" || variant === "card") await $.ui.close({ id: PANE })
    else {
      const opened = await $.ui.open({ id: PANE, title: `viz: ${variant}`, closeOnEscape: true, ...(variant === "side" ? { columns: 72 } : { rows: 24 }) })
      if (!opened.isPlaced) return { text: `pane not placed: ${opened.reason}` }
    }
    $.ui.invalidate("ui.render")
    if (variant === "card") return { text: fixture?.result ?? "" }
    return { text: `${variant} at ${when ?? "end"}` }
  })

  on("ui.render", { component: "Pane", requestId: PANE }, ($, e) => {
    if (fixture === undefined) return undefined
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
