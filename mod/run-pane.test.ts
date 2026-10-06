import { describe, expect, it } from "vitest"
import type { AgentActivity } from "./agents.ts"
import { type PaneElements, paneRows, renderRunPane, type RunView } from "./run-pane.ts"

const RUN = "2026-10-06T00-49-12-527Z-0ce2"

const activity = (invocationId: string, patch: Partial<AgentActivity>): AgentActivity => ({
  id: `session-${invocationId}`,
  invocationId,
  state: "running",
  spawnedAt: 1_000,
  turns: 0,
  toolCalls: 0,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  ...patch,
})

const view: RunView = {
  argv: ["review", "--related-files", "--pr=641"],
  runId: RUN,
  startedAt: 0,
  endedAt: undefined,
  lenses: ["absence", "lens-b", "lens-c"],
  findersFinished: false,
  activity: [
    activity(`${RUN}-finders-1-finder-absence`, {
      state: "answered",
      endedAt: 69_000,
      items: 5,
      tokens: { input: 1_000, output: 4_000, cacheRead: 99_000, cacheWrite: 0 },
    }),
    activity(`${RUN}-finders-2-finder-lens-b`, { toolCalls: 14, lastTool: "Read platform/publish-app.ts" }),
    activity(`${RUN}-pool`, { state: "waiting" }),
  ],
  latest: "gauntlet: finder absence done — 5 candidates · 68s · $3.41 · cache 99%",
  exitCode: undefined,
}

// Draws the tree as indented text: Box children on their own lines, a row's
// cells joined.
const text: PaneElements<string> = {
  Box: ({ children, flexDirection }) => [children ?? []].flat().join(flexDirection === "row" ? " " : "\n"),
  Text: ({ children }) => children ?? "",
  Button: ({ label }) => `[ ${label} ]`,
}

describe("run pane", () => {
  it("lists every loaded Finder before it opens, then the later stages", () => {
    expect(paneRows(view).map((row) => `${row.stage}/${row.name}/${row.activity?.state ?? "-"}`)).toEqual([
      "Finders/absence/answered",
      "Finders/lens-b/running",
      "Finders/lens-c/-",
      "Pool/Pool/waiting",
    ])
  })

  it("draws each invocation's state, tokens and live activity", () => {
    const drawn = renderRunPane(view, text, 80, 101_000, { stop: () => undefined, close: () => undefined })
    expect(drawn).toContain("--pr=641 · run 0ce2 · 1:41 · running · 1 live [ Stop review ]")
    expect(drawn).toContain("Finders 1/3")
    expect(drawn).toMatch(/✓ absence +5 found · 100K in \(99% cached\) · 4K out +1:08/)
    expect(drawn).toMatch(/● lens-b +Read platform\/publish-app.ts · 14 calls +1:40/)
    expect(drawn).toMatch(/○ lens-c +not started/)
    expect(drawn).toMatch(/○ Pool +waiting for an agent slot/)
  })

  it("folds a stage whose agents have all ended into one row", () => {
    const ended: RunView = {
      ...view,
      endedAt: 130_000,
      findersFinished: true,
      exitCode: 0,
      activity: view.activity.map((each) =>
        each.invocationId.endsWith("lens-b") ? { ...each, state: "answered", endedAt: 120_000, items: 2 } : each
      ),
    }
    const drawn = renderRunPane(ended, text, 80, 200_000, { stop: () => undefined, close: () => undefined })
    expect(drawn).toContain("finished [ Close ]")
    expect(drawn).toMatch(/✓ Finders +2 ran · 1 not run · 7 found · 100K in \(99% cached\) · 4K out +1:59/)
    expect(drawn).not.toContain("lens-c")
  })
})
