// The strip's stage row as one SVG, for the surfaces whose text is
// proportional (desktop, the editor, mobile): mod/strip.ts hands it each
// stage's marks and, once the dossier is written, its Review Priority counts.
// Its geometry is fixed, so no mark shifts the row as it changes, and its
// motion is SMIL inside the markup: a running agent pings, and the line into
// the stage at work flows. The markup holds no clock, so it changes only when
// a mark does, and each mark's <title> names its agent.

export type MarkState = "waiting" | "running" | "answered" | "failed" | "skipped"

export interface TrackMark {
  readonly state: MarkState
  // The agent's tooltip: its lens or bundle, and what it found.
  readonly label: string
}

export interface TrackStage {
  readonly name: string
  readonly color: string
  readonly started: boolean
  readonly finished: boolean
  readonly marks: ReadonlyArray<TrackMark>
}

export interface TrackPill {
  readonly text: string
  readonly color: string
}

export interface TrackSvg {
  readonly source: string
  readonly width: number
  readonly height: number
}

const HEIGHT = 40
const LABEL_Y = 12
const DOT_Y = 28
const RADIUS = 5.5
const PITCH = 17
const GAP = 30
const MUTED = "#8b8b8b"
const FAILED = "#e5484d"
// Labels are small caps in the system face; this is their measured advance
// per letter, with room to spare.
const LETTER = 9

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

const num = (value: number) => String(Math.round(value * 10) / 10)

const titled = (label: string, body: string) => `<g>${body}<title>${escape(label)}</title></g>`

// One agent's mark at (x, DOT_Y); `nth` staggers the pings so a stage of
// several running agents ripples instead of beating as one.
const markSvg = (mark: TrackMark, x: number, color: string, nth: number) => {
  const cx = num(x)
  const cy = num(DOT_Y)
  const r = num(RADIUS)
  switch (mark.state) {
    case "running": {
      const begin = `${num((nth % 6) * 0.27)}s`
      return titled(
        mark.label,
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="2">` +
          `<animate attributeName="r" values="${r};13" dur="1.6s" begin="${begin}" repeatCount="indefinite"/>` +
          `<animate attributeName="stroke-opacity" values="0.75;0" dur="1.6s" begin="${begin}" repeatCount="indefinite"/></circle>` +
          `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" filter="url(#glow)">` +
          `<animate attributeName="fill-opacity" values="1;0.55;1" dur="1.6s" begin="${begin}" repeatCount="indefinite"/></circle>`,
      )
    }
    case "answered":
      return titled(
        mark.label,
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}"/>` +
          `<path d="M${num(x - 2.6)} ${num(DOT_Y + 0.2)}l1.8 1.9l3.5-3.9" fill="none" stroke="#fff" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>`,
      )
    case "failed":
      return titled(
        mark.label,
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${FAILED}"/>` +
          `<path d="M${num(x - 2.2)} ${num(DOT_Y - 2.2)}l4.4 4.4M${num(x + 2.2)} ${num(DOT_Y - 2.2)}l-4.4 4.4" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/>`,
      )
    case "skipped":
      return titled(
        mark.label,
        `<circle cx="${cx}" cy="${cy}" r="${num(RADIUS - 0.75)}" fill="none" stroke="${MUTED}" stroke-width="1.3" stroke-dasharray="2 2" opacity="0.7"/>` +
          `<path d="M${num(x - 2.6)} ${num(DOT_Y + 2.6)}l5.2-5.2" stroke="${MUTED}" stroke-width="1.3" opacity="0.7"/>`,
      )
    case "waiting":
      return titled(
        mark.label,
        `<circle cx="${cx}" cy="${cy}" r="${num(RADIUS - 0.75)}" fill="none" stroke="${MUTED}" stroke-width="1.5" opacity="0.6"/>`,
      )
  }
}

// The line between two stages: faint until the stage after it starts, solid
// in its color once that stage is under way, and flowing toward it while it
// works.
const connectorSvg = (from: number, to: number, next: TrackStage) => {
  const line = `x1="${num(from)}" y1="${num(DOT_Y)}" x2="${num(to)}" y2="${num(DOT_Y)}"`
  if (!next.started) return `<line ${line} stroke="${MUTED}" stroke-width="1.5" stroke-opacity="0.35" stroke-linecap="round"/>`
  if (next.finished) return `<line ${line} stroke="${next.color}" stroke-width="1.5" stroke-opacity="0.55" stroke-linecap="round"/>`
  return `<line ${line} stroke="${next.color}" stroke-width="1.5" stroke-opacity="0.25" stroke-linecap="round"/>` +
    `<line ${line} stroke="${next.color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 7">` +
    `<animate attributeName="stroke-dashoffset" values="20;0" dur="0.7s" repeatCount="indefinite"/></line>`
}

const pillSvg = (pill: TrackPill, x: number) => {
  const width = pill.text.length * 7 + 16
  return {
    width,
    source: `<rect x="${num(x)}" y="${num(DOT_Y - 10)}" width="${num(width)}" height="20" rx="10" fill="${pill.color}" fill-opacity="0.14" stroke="${pill.color}" stroke-opacity="0.6"/>` +
      `<text x="${num(x + width / 2)}" y="${num(DOT_Y + 4)}" text-anchor="middle" fill="${pill.color}" class="pill">${escape(pill.text)}</text>`,
  }
}

export const trackSvg = (stages: ReadonlyArray<TrackStage>, pills: ReadonlyArray<TrackPill>): TrackSvg => {
  const parts: Array<string> = []
  let x = 2
  stages.forEach((stage, at) => {
    const marks: ReadonlyArray<TrackMark> = stage.marks.length === 0 ? [{ state: "waiting", label: `${stage.name}: nothing yet` }] : stage.marks
    const active = stage.started && !stage.finished
    parts.push(
      `<text x="${num(x)}" y="${num(LABEL_Y)}" class="label${active ? " active" : ""}" fill="${stage.started ? stage.color : MUTED}">${escape(stage.name.toUpperCase())}</text>`,
    )
    let running = 0
    marks.forEach((mark, index) => {
      parts.push(markSvg(mark, x + RADIUS + 1 + index * PITCH, stage.color, mark.state === "running" ? running++ : 0))
    })
    const dotsEnd = x + 2 + RADIUS * 2 + (marks.length - 1) * PITCH
    const end = Math.max(dotsEnd, x + stage.name.length * LETTER)
    const following = stages[at + 1]
    if (following !== undefined) parts.push(connectorSvg(dotsEnd + 5, end + GAP - 5, following))
    x = end + GAP
  })
  // The counts stand close after the track.
  x -= GAP - 16
  pills.forEach((pill) => {
    const drawn = pillSvg(pill, x)
    parts.push(drawn.source)
    x += drawn.width + 6
  })
  const width = Math.ceil(x - (pills.length > 0 ? 6 : 16) + 2)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(width)} ${String(HEIGHT)}">` +
    `<defs><filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.6" result="blur"/>` +
    `<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}` +
    `.label{font-size:10px;font-weight:600;letter-spacing:1.2px}.active{font-weight:800}.pill{font-size:11px;font-weight:700}</style></defs>` +
    `${parts.join("")}</svg>`
  return { source, width, height: HEIGHT }
}
