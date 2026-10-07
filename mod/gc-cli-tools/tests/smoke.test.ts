// `claude plugin test` smoke test of the built gc-cli-tools plugin: its
// bundle loads in the hooks environment, and its emit tools answer with the
// review program's strict decoders, only for an agent gc-cli published.
// `bun run build-mod` copies it into the built plugin; it runs only there.
import type { On, Register } from "claude-code"
import { describe, type Engine, expect, test } from "claude-code/testing"

const AGENT = "agent-smoke"
const EMIT = "mcp__gc-cli-tools__emit_judgments"

// Stands in for gc-cli, which publishes each agent it spawns. An inline
// plugin loads on its own, so it spells AGENT and EMIT out.
const publishing: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.state.set(
      { plugin: "gc-cli", key: "agents", id: "agent-smoke" },
      { invocation: "smoke-judgment#1", emitTool: "mcp__gc-cli-tools__emit_judgments", root: "/smoke" },
    )
    return next(e)
  })
}

const options = { plugins: [{ name: "gc-cli", register: publishing }] }

// What a session answers beneath the plugins: the start, and the emit tools
// gc-cli-tools registers there.
const start = async ($: Engine, on: On) => {
  on("session.start", async (_, e) => ({ cwd: e.cwd }))
  on("tool.register", async (_, e) => ({ value: { tool: e.name } }))
  await $.session.start({ cwd: "/smoke", surface: null, isInteractive: false })
}

describe("gc-cli-tools", () => {
  test("refuses an emit from an agent gc-cli did not publish", options, async ($, on) => {
    await start($, on)
    const answer = await $.tool.call({ tool: EMIT, agentId: "agent-stranger", decisions: [] })
    expect(answer.deny).toContain("serves only Gauntlet invocation agents")
  })

  test("answers a published agent's emit with the strict decoder", options, async ($, on) => {
    await start($, on)
    const accepted = await $.tool.call({
      tool: EMIT,
      agentId: AGENT,
      decisions: [{ index: 1, decision: "merge", into: 2, reason: "the same root observation" }],
    })
    expect(accepted.deny).toBeUndefined()
    expect(String(accepted.result)).toContain("Recorded")

    const refused = await $.tool.call({ tool: EMIT, agentId: AGENT, decisions: [{ index: 0, decision: "drop" }] })
    expect(refused.deny).toBeDefined()
  })
})
