import { describe, expect, it } from "vitest"
import type { AgentActivity } from "./activity.ts"
import { doing, type PaneElements, renderStrip, type RunView, type StripActions } from "./strip.ts"

const RUN = "2026-10-06T00-49-12-527Z-0ce2"

const agent = (invocationId: string, state: AgentActivity["state"], items?: number): AgentActivity => {
  const activity: AgentActivity = { id: invocationId, invocationId: `${RUN}-${invocationId}`, state }
  if (items !== undefined) activity.items = items
  return activity
}

const finder = (lens: string, state: AgentActivity["state"], items?: number) =>
  agent(`finders-1-finder-${lens}`, state, items)

const lenses = ["absence", "lens-b", "lens-c"]

const running: RunView = {
  startedAt: 0,
  endedAt: undefined,
  lenses,
  skipped: [],
  findersFinished: false,
  routed: undefined,
  activity: [],
  exitCode: undefined,
  result: undefined,
  refusal: undefined,
  post: undefined,
}

const findersDone: RunView = {
  ...running,
  findersFinished: true,
  routed: { bugClaims: 9, observations: 14 },
  activity: [finder("absence", "answered", 5), finder("lens-b", "answered", 18), finder("lens-c", "answered", 0)],
}

const finished = (patch: Partial<NonNullable<RunView["result"]>>): RunView => ({
  ...findersDone,
  endedAt: 754_000,
  exitCode: 0,
  result: { _tag: "Reviewed", entries: [], coverageGaps: [], dossierMarkdown: "/runs/r/dossier.md", ...patch },
})

// Draws the tree as text: a row's cells joined, a column's rows on lines.
const text: PaneElements<string> = {
  Box: ({ children, flexDirection }) => [children ?? []].flat().join(flexDirection === "column" ? "\n" : ""),
  Text: ({ children }) => children ?? "",
  Button: ({ label }) => ` [ ${label} ]`,
}

const actions: StripActions = { stop: () => undefined, openDossier: () => undefined, dismiss: () => undefined }
const terminal = { surface: "terminal", columns: 80 } as const

const draw = (view: RunView, now = 0) => renderStrip(view, text, terminal, now, actions)

describe("strip", () => {
  it("says what the run is doing at each stage, from milestones and agent activity", () => {
    const withAgents = (view: RunView, ...more: ReadonlyArray<AgentActivity>): RunView => ({
      ...view,
      activity: [...view.activity, ...more],
    })
    expect([
      running,
      withAgents(running, finder("absence", "running")),
      withAgents(running, finder("absence", "answered", 5), finder("lens-b", "running"), finder("lens-c", "opening")),
      withAgents(running, finder("absence", "running"), finder("lens-b", "running")),
      withAgents(findersDone, agent("pool", "running")),
      withAgents(findersDone, agent("pool", "answered"), agent("verification-1", "running"), agent("judgment", "running")),
      withAgents(findersDone, agent("pool", "answered"), agent("verification-1", "answered"), agent("judgment", "running")),
      withAgents(findersDone, agent("pool", "answered"), agent("verification-1", "failed"), agent("judgment", "answered")),
      { ...findersDone, routed: { bugClaims: 0, observations: 0 } },
      {
        ...running,
        lenses: [],
        skipped: [{ lens: "absence", reason: "no fixture manifest" }],
        findersFinished: true,
        routed: { bugClaims: 0, observations: 0 },
      },
    ].map(doing)).toEqual([
      "Building the first prompt",
      "Sending the first finder to set the cache",
      "2 finders still looking · 5 leads so far",
      "3 finders looking for bugs",
      "Grouping 9 possible bugs for checking · 14 notes to weigh",
      "Double-checking 9 possible bugs · weighing 14 notes",
      "Weighing 14 notes",
      "Writing the dossier",
      "Writing the dossier",
      "Writing the dossier",
    ])
  })

  it("draws one mark per agent while running, done first", () => {
    const view: RunView = {
      ...running,
      activity: [finder("absence", "answered", 5), finder("lens-b", "running"), finder("lens-c", "failed")],
    }
    expect(draw(view, 61_000)).toBe(
      "◆ Gauntlet  Find ✓✗●  Pool ○  Verify ○  Judge ○ [ Stop ]\n1:01 · 1 finder still looking · 5 leads so far",
    )
    expect(draw(view, 61_500)).toContain("✓✗◉")
    // Proportional text keeps one glyph, so a blink never shifts the row.
    const desktop = { surface: "desktop", columns: 80 } as const
    expect(renderStrip(view, text, desktop, 61_500, actions)).toContain("✓✗●")
  })

  it("draws the stage row and its clock as one SVG off the terminal", () => {
    const sources: Array<string> = []
    const drawing: PaneElements<string> = {
      ...text,
      Svg: ({ source }) => {
        sources.push(source)
        return "[svg]"
      },
    }
    const desktop = { surface: "desktop", columns: 80 } as const
    const view: RunView = {
      ...running,
      skipped: [{ lens: "lens-d", reason: "no fixture manifest" }],
      activity: [finder("absence", "answered", 5), finder("lens-b", "running")],
    }
    expect(renderStrip(view, drawing, desktop, 61_000, actions)).toBe(
      "◆ Gauntlet  [svg] [ Stop ]\n2 finders still looking · 5 leads so far · not run: lens-d (no fixture manifest)",
    )
    // The clock turns in the drawing from the run's age at the draw, and the
    // running agent's ping from the wall clock's, so a redraw resumes both.
    expect(sources[0]).toContain("steps(10) -1s infinite")
    expect(sources[0]).toContain('class="ping" style="animation-delay:-0.2s"')
    for (const title of ["absence: 5 leads", "lens-b: looking", "lens-c: waiting", "lens-d: not run (no fixture manifest)"]) {
      expect(sources[0]).toContain(`<title>${title}</title>`)
    }
    expect(renderStrip(finished({ entries: [{ tag: "confirmed", reviewPriority: "P1" }] }), drawing, desktop, 0, actions)).toBe(
      "◆ Gauntlet  [svg] [ Open dossier ] [ Dismiss ]\n1 finding from 23 leads",
    )
    expect(sources.at(-1)).toContain(">P1 1</text>")
  })

  it("draws a skipped lens as not run and leaves it out of the finders still looking", () => {
    const view: RunView = {
      ...running,
      lenses: ["absence", "lens-b"],
      skipped: [{ lens: "lens-c", reason: "no fixture manifest" }],
      activity: [finder("absence", "answered", 5), finder("lens-b", "answered", 18)],
    }
    expect(draw(view, 61_000)).toBe(
      "◆ Gauntlet  Find ✓✓⊘  Pool ○  Verify ○  Judge ○ [ Stop ]\n1:01 · 0 finders still looking · 23 leads so far · not run: lens-c (no fixture manifest)",
    )
  })

  it("shows the Review Priority counts with Open dossier and Dismiss once finished", () => {
    const view = finished({
      entries: [
        { tag: "confirmed", reviewPriority: "P1" },
        { tag: "judgment", reviewPriority: "P2" },
        { tag: "confirmed", reviewPriority: "P2" },
        { tag: "undecided" },
      ],
    })
    expect(draw(view)).toBe(
      "◆ Gauntlet  P1 1 · P2 2 · 1 unranked [ Open dossier ] [ Dismiss ]\n12:34 · 4 findings from 23 leads",
    )
  })

  it("says no findings, and names the coverage gaps", () => {
    expect(draw(finished({}))).toBe(
      "◆ Gauntlet  no findings [ Open dossier ] [ Dismiss ]\n12:34 · 0 findings from 23 leads",
    )
    const gapped = finished({
      coverageGaps: [
        { stage: "finders", lens: "absence", reason: "MissingEmit" },
        { stage: "finders", lens: "lens-b", reason: "Timeout" },
        { stage: "verification", reason: "bundle 2 failed" },
      ],
    })
    expect(draw(gapped).split("\n")[1]).toBe("12:34 · 0 findings from 23 leads · 2 finders failed · 1 verification gap")
  })

  it("says where a pull-request review's post landed, or why it did not", () => {
    const posted = { ...finished({}), post: { state: "posted" as const, text: "posted https://github.com/o/r/pull/7#c" } }
    const failed = { ...finished({}), post: { state: "failed" as const, text: `fixture refusal; check the pull request for the comment before /gauntlet deliver ${RUN}` } }
    expect([posted, failed].map((view) => draw(view).split("\n").slice(1))).toEqual([
      ["12:34 · 0 findings from 23 leads", "posted https://github.com/o/r/pull/7#c"],
      ["12:34 · 0 findings from 23 leads", `fixture refusal; check the pull request for the comment before /gauntlet deliver ${RUN}`],
    ])
  })

  it("says why a review could not run", () => {
    const refused: RunView = {
      ...running,
      endedAt: 2_000,
      exitCode: 1,
      refusal: "could not review — nothing to review: the working tree is clean",
    }
    expect(draw(refused)).toBe(
      "◆ Gauntlet  could not review [ Dismiss ]\n0:02 · could not review — nothing to review: the working tree is clean",
    )
  })

  it("sizes to the band's cells on the terminal and stretches elsewhere", () => {
    const widths: Array<number | string | undefined> = []
    const measured: PaneElements<string> = {
      ...text,
      Box: (props) => {
        widths.push(props.width)
        return text.Box(props)
      },
    }
    renderStrip(running, measured, terminal, 0, actions)
    renderStrip(running, measured, { surface: "desktop", columns: 80 }, 0, actions)
    expect(widths.at(-1)).toBe("100%")
    expect(widths).toContain(80)
  })
})
