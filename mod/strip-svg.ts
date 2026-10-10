// The strip's stage row as one SVG, for the surfaces whose text is
// proportional (desktop, the editor, mobile): mod/strip.ts hands it each
// stage's marks and, once the dossier is written, its Review Priority counts.
// Its geometry is fixed, so no mark shifts the row as it changes, and its
// motion is CSS inside the markup: a running agent pings, the line into the
// stage at work flows, and the elapsed clock turns as an odometer. The desktop
// builds a new image from the markup on every redraw, so each animation's
// phase is set from the wall clock at the draw (a negative delay), and a
// redraw resumes the motion where it was instead of restarting it.

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

// The draw's wall-clock time, the run's age then, and whether its clock
// still turns.
export interface TrackClock {
  readonly now: number
  readonly seconds: number
  readonly running: boolean
}

// How far into its `period` (seconds) an animation running since the epoch
// is at `now`, as the negative delay that starts it there; `offset` shifts
// it, so marks that ripple keep their places in the ripple.
const phase = (now: number, period: number, offset = 0) => `${num(-(((now / 1000 + offset) % period)), 3)}s`

export interface TrackSvg {
  readonly source: string
  readonly width: number
  readonly height: number
}

// A running mark's ping reaches 13 past its centre: the margins keep it whole.
const MARGIN = 8
const HEIGHT = 44
const LABEL_Y = 12
const DOT_Y = 28
const RADIUS = 5.5
const PITCH = 17
// Every line between stages is this long, from the last mark of one, so a
// stage of many marks sits as far from the next as a stage of one.
const CONNECT = 40
// Between the track, the counts and the clock, each under its own label.
const SECTION = 22
const MUTED = "#8b8b8b"
const FAILED = "#e5484d"
// Labels are small caps in the system face; this is their measured advance
// per letter, with room to spare.
const LETTER = 9

const escape = (text: string) =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll("\"", "&quot;")

const num = (value: number, places = 1) => String(Math.round(value * 10 ** places) / 10 ** places)

const titled = (label: string, body: string) => `<g><title>${escape(label)}</title>${body}</g>`

// One agent's mark at (x, DOT_Y); `nth` staggers the pings so a stage of
// several running agents ripples instead of beating as one.
const markSvg = (mark: TrackMark, x: number, color: string, nth: number, now: number) => {
  const cx = num(x)
  const cy = num(DOT_Y)
  const r = num(RADIUS)
  switch (mark.state) {
    case "running": {
      const delay = `animation-delay:${phase(now, 1.6, -(nth % 6) * 0.27)}`
      return titled(
        mark.label,
        `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="2" class="ping" style="${delay}"/>` +
          `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" filter="url(#glow)" class="breathe" style="${delay}"/>`,
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
const connectorSvg = (from: number, to: number, next: TrackStage, now: number) => {
  const line = `x1="${num(from)}" y1="${num(DOT_Y)}" x2="${num(to)}" y2="${num(DOT_Y)}"`
  if (!next.started) return `<line ${line} stroke="${MUTED}" stroke-width="1.5" stroke-opacity="0.35" stroke-linecap="round"/>`
  if (next.finished) return `<line ${line} stroke="${next.color}" stroke-width="1.5" stroke-opacity="0.55" stroke-linecap="round"/>`
  return `<line ${line} stroke="${next.color}" stroke-width="1.5" stroke-opacity="0.25" stroke-linecap="round"/>` +
    `<line ${line} stroke="${next.color}" stroke-width="2" stroke-linecap="round" stroke-dasharray="3 7" class="flow" style="animation-delay:${phase(now, 0.7)}"/>`
}

const pillSvg = (pill: TrackPill, x: number) => {
  const width = pill.text.length * 7 + 16
  return {
    width,
    source: `<rect x="${num(x)}" y="${num(DOT_Y - 10)}" width="${num(width)}" height="20" rx="10" fill="${pill.color}" fill-opacity="0.14" stroke="${pill.color}" stroke-opacity="0.6"/>` +
      `<text x="${num(x + width / 2)}" y="${num(DOT_Y + 4)}" text-anchor="middle" fill="${pill.color}" class="pill">${escape(pill.text)}</text>`,
  }
}

const DIGIT = 7
const DIGIT_LINE = 14

// One odometer wheel: its glyphs stacked a line apart, stepped one line every
// `period / glyphs.length` seconds, begun `age` seconds into its turn.
const wheelSvg = (x: number, glyphs: ReadonlyArray<string>, period: number, clock: TrackClock) => {
  const age = Math.floor(clock.seconds % period)
  const at = Math.floor(age / (period / glyphs.length))
  const stack = glyphs.map((glyph, index) =>
    `<text x="${num(x)}" y="${num(DOT_Y + 4 + index * DIGIT_LINE)}" class="clock">${glyph}</text>`
  ).join("")
  if (!clock.running) {
    return `<g transform="translate(0 ${String(-at * DIGIT_LINE)})">${stack}</g>`
  }
  const animation = `animation:wheel${String(glyphs.length)} ${String(period)}s steps(${String(glyphs.length)}) ${num(-(clock.seconds % period), 3)}s infinite`
  return `<g style="${animation}">${stack}</g>`
}

// m:ss, a minute's tens shown only from ten minutes on.
const clockSvg = (x: number, clock: TrackClock) => {
  const ten = ["0", "1", "2", "3", "4", "5", "6", "7", "8", "9"]
  const parts = [
    wheelSvg(x, ["", ...ten.slice(1)], 6000, clock),
    wheelSvg(x + DIGIT, ten, 600, clock),
    `<text x="${num(x + DIGIT * 2)}" y="${num(DOT_Y + 4)}" class="clock">:</text>`,
    wheelSvg(x + DIGIT * 2 + 4, ten.slice(0, 6), 60, clock),
    wheelSvg(x + DIGIT * 3 + 4, ten, 10, clock),
  ]
  return {
    width: DIGIT * 4 + 4,
    source: `<g clip-path="url(#window)">${parts.join("")}</g>`,
  }
}

export const trackSvg = (stages: ReadonlyArray<TrackStage>, pills: ReadonlyArray<TrackPill>, clock: TrackClock): TrackSvg => {
  const parts: Array<string> = []
  const label = (x: number, text: string, fill: string, options: { readonly active?: boolean; readonly end?: boolean } = {}) =>
    `<text x="${num(x)}" y="${num(LABEL_Y)}"${options.end === true ? ' text-anchor="end"' : ""} class="label${options.active === true ? " active" : ""}" fill="${fill}">${escape(text.toUpperCase())}</text>`
  let x = MARGIN
  stages.forEach((stage, at) => {
    const marks: ReadonlyArray<TrackMark> = stage.marks.length === 0 ? [{ state: "waiting", label: `${stage.name}: nothing yet` }] : stage.marks
    const active = stage.started && !stage.finished
    parts.push(label(x, stage.name, stage.started ? stage.color : MUTED, { active }))
    let running = 0
    marks.forEach((mark, index) => {
      parts.push(markSvg(mark, x + RADIUS + 1 + index * PITCH, stage.color, mark.state === "running" ? running++ : 0, clock.now))
    })
    const dotsEnd = x + 2 + RADIUS * 2 + (marks.length - 1) * PITCH
    const labelEnd = x + stage.name.length * LETTER
    const following = stages[at + 1]
    if (following === undefined) {
      x = Math.max(dotsEnd, labelEnd)
      return
    }
    // A label longer than its marks may push the next stage, and the line, on.
    const next = Math.max(dotsEnd + CONNECT + 10, labelEnd + 12)
    parts.push(connectorSvg(dotsEnd + 5, next - 5, following, clock.now))
    x = next
  })
  if (pills.length > 0) {
    x += SECTION
    parts.push(label(x, "findings", MUTED))
    pills.forEach((pill, at) => {
      const drawn = pillSvg(pill, x + (at === 0 ? 0 : 6))
      parts.push(drawn.source)
      x += drawn.width + (at === 0 ? 0 : 6)
    })
  }
  x += SECTION
  const timer = clockSvg(x, clock)
  // Over the clock's right edge: its minutes' tens wheel is blank until ten.
  parts.push(label(x + timer.width, "time", MUTED, { end: true }))
  parts.push(timer.source)
  const clockX = x
  x += timer.width
  const width = Math.ceil(x + MARGIN)
  const source = `<svg xmlns="http://www.w3.org/2000/svg" width="${String(width)}" height="${String(HEIGHT)}" viewBox="0 0 ${String(width)} ${String(HEIGHT)}">` +
    `<defs><filter id="glow" x="-100%" y="-100%" width="300%" height="300%"><feGaussianBlur stdDeviation="1.6" result="blur"/>` +
    `<feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge></filter>` +
    `<clipPath id="window"><rect x="${num(clockX - 2)}" y="${num(DOT_Y - 8)}" width="${String(timer.width + 4)}" height="${String(DIGIT_LINE)}"/></clipPath>` +
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;font-variant-numeric:tabular-nums}` +
    `.label{font-size:10px;font-weight:600;letter-spacing:1.2px}.active{font-weight:800}.pill{font-size:11px;font-weight:700}` +
    `.clock{font-size:12px;font-weight:500;fill:${MUTED}}` +
    `.ping{transform-box:fill-box;transform-origin:center;vector-effect:non-scaling-stroke;animation:ping 1.6s linear infinite}` +
    `.breathe{animation:breathe 1.6s ease-in-out infinite}.flow{animation:flow 0.7s linear infinite}` +
    `@keyframes ping{from{transform:scale(1);opacity:0.75}to{transform:scale(2.36);opacity:0}}` +
    `@keyframes breathe{50%{opacity:0.55}}@keyframes flow{from{stroke-dashoffset:20}to{stroke-dashoffset:0}}` +
    [6, 10].map((glyphs) => `@keyframes wheel${String(glyphs)}{to{transform:translateY(${String(-glyphs * DIGIT_LINE)}px)}}`).join("") +
    `</style></defs>` +
    `${parts.join("")}</svg>`
  return { source, width, height: HEIGHT }
}
