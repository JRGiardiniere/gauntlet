// `claude plugin test` smoke test of the built gauntlet-tools plugin: its
// bundle loads in the hooks environment, and its emit tools answer with the
// review program's strict decoders, only for an agent the gauntlet plugin
// published, whose responses it records for the engine.
// `bun run build-mod` copies it into the built plugin; it runs only there.
import type { On, Register } from "claude-code"
import { describe, type Engine, expect, test } from "claude-code/testing"

const AGENT = "agent-smoke"
const EMIT = "mcp__gauntlet-tools__emit_judgments"

// Stands in for the gauntlet plugin, which publishes each agent it spawns and
// reads what gauntlet-tools saw of it when its turn ends (answered here as the
// turn's text). An inline plugin loads on its own, so it spells AGENT and EMIT out.
const publishing: Register = (on) => {
  on("session.start", async ($, e, next) => {
    await $.state.set(
      { plugin: "gauntlet", key: "agents", id: "agent-smoke" },
      { invocation: "smoke-judgment#1", emitTool: "mcp__gauntlet-tools__emit_judgments", root: "/smoke" },
    )
    return next(e)
  })
  on("turn.complete", async ($, e) => ({
    text: JSON.stringify((await $.state.get({ plugin: "gauntlet-tools", key: "events", id: e.agentId ?? "" })).value ?? []),
  }))
}

const options = { plugins: [{ name: "gauntlet", register: publishing }] }

// What a session answers beneath the plugins: the start, and the emit tools
// gauntlet-tools registers there.
const start = async ($: Engine, on: On) => {
  on("session.start", async (_, e) => ({ cwd: e.cwd }))
  on("tool.register", async (_, e) => ({ value: { tool: e.name } }))
  await $.session.start({ cwd: "/smoke", surface: null, isInteractive: false })
}

describe("gauntlet-tools", () => {
  test("refuses an emit from an agent the gauntlet plugin did not publish", options, async ($, on) => {
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

  test("records a published agent's response for the engine and passes it through", options, async ($, on) => {
    const usage = { input_tokens: 2, output_tokens: 64, cache_read_input_tokens: 3052, cache_creation_input_tokens: 80649, model: "claude-smoke" }
    const response = { turnId: "turn-smoke", index: 0, answer: "", toolUses: [], stopReason: "max_tokens" as const, usage }
    // The model's response, beneath the plugins.
    on("turn.step", async function* () {
      return response
    })
    await start($, on)

    const step = $.turn.step({ turnId: "turn-smoke", index: 0, model: "claude-smoke", messageCount: 1, agentId: AGENT })
    let read = await step.next()
    while (read.done !== true) read = await step.next()

    expect(read.value).toEqual(response)
    const completed = await $.turn.complete({ answer: "", durationMs: 1, isAborted: false, turnId: "turn-smoke", agentId: AGENT, reason: "answer" })
    expect(JSON.parse(completed.text)).toEqual([{ type: "message_end", stopReason: "max_tokens", usage }])
  })
})
