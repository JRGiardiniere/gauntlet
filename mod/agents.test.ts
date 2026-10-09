import { describe, expect, it } from "vitest"
import { type ClaudeHostCommand, makeClaudeHost } from "../src/harness/claude-host.ts"
import { type AgentPorts, makeAgentDriver, type SpawnAnswer } from "./agents.ts"

const OPEN: ClaudeHostCommand = {
  kind: "open",
  id: "session-1",
  invocationId: "run-finders-1-finder-fixture",
  seat: "claude-code/sonnet:low",
  cwd: "/snapshot",
  systemPrompt: "fixture system prompt",
  emitTool: { name: "emit_findings", description: "fixture", parameters: {} },
  tools: ["read"],
}

// Lets the driver's fire-and-forget promises settle.
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

const makePorts = (spawn: () => Promise<SpawnAnswer>, register: () => Promise<void> = async () => {}) => {
  const stopped: Array<string> = []
  const ports: AgentPorts = {
    register,
    spawn,
    resume: async () => undefined,
    stop: async (agentId) => {
      stopped.push(agentId)
      return undefined
    },
    publish: async () => {},
    pull: async () => [],
    log: () => {},
  }
  return { ports, stopped }
}

const started = async (driver: ReturnType<typeof makeAgentDriver>, id = OPEN.id) => {
  driver.send({ ...OPEN, id })
  await settle()
  driver.send({ kind: "prompt", id, text: "review", turn: 0 })
  await settle()
}

const states = (driver: ReturnType<typeof makeAgentDriver>) => driver.activity().map((activity) => activity.state)

describe("the agent driver", () => {
  it("stops a running agent whose session is disposed, as an interrupted run does", async () => {
    const { ports, stopped } = makePorts(async () => ({ agentId: "agent-1" }))
    const driver = makeAgentDriver(ports)
    await started(driver)

    driver.send({ kind: "dispose", id: OPEN.id })
    await settle()

    expect(stopped).toEqual(["agent-1"])
    expect(driver.agentIds()).toEqual([])
    expect(states(driver)).toEqual(["stopped"])
  })

  it("leaves an agent whose turn has ended alone when its session is disposed", async () => {
    const { ports, stopped } = makePorts(async () => ({ agentId: "agent-1" }))
    const driver = makeAgentDriver(ports)
    await started(driver)
    await driver.turnComplete({ agentId: "agent-1", reason: "answer", answer: "" })

    driver.send({ kind: "dispose", id: OPEN.id })
    await settle()

    expect(stopped).toEqual([])
  })

  it("stops an agent whose spawn lands after its session was disposed", async () => {
    let land: (answer: SpawnAnswer) => void = () => {}
    const { ports, stopped } = makePorts(() => new Promise((resolve) => (land = resolve)))
    const driver = makeAgentDriver(ports)
    await started(driver)

    driver.send({ kind: "dispose", id: OPEN.id })
    land({ agentId: "agent-1" })
    await settle()

    expect(stopped).toEqual(["agent-1"])
    expect(driver.agentIds()).toEqual([])
  })

  it("leaves nothing open when a session is disposed while its slot registers", async () => {
    let registered: () => void = () => {}
    const { ports, stopped } = makePorts(
      async () => ({ agentId: "agent-1" }),
      () => new Promise((resolve) => (registered = resolve)),
    )
    const driver = makeAgentDriver(ports)
    driver.send(OPEN)
    await settle()

    driver.send({ kind: "dispose", id: OPEN.id })
    registered()
    await settle()
    await driver.stopAll("run ended")

    expect(states(driver)).toEqual(["stopped"])
    expect(stopped).toEqual([])
  })

  it("ends a denied spawn at once when none of the run's agents is live", async () => {
    const { ports } = makePorts(async () => ({ deny: "fixture denial" }))
    const driver = makeAgentDriver(ports)
    await started(driver)

    expect(states(driver)).toEqual(["failed"])
  })

  it("queues a denied spawn while another of the run's agents is live", async () => {
    let spawns = 0
    const { ports } = makePorts(async () => {
      spawns += 1
      return spawns === 1 ? { agentId: "agent-1" } : { deny: "fixture denial" }
    })
    const driver = makeAgentDriver(ports)
    await started(driver)
    await started(driver, "session-2")

    expect(states(driver)).toEqual(["running", "waiting"])
    driver.send({ kind: "dispose", id: "session-2" })
  })

  it("starts a new run from nothing, with no agents or queued spawns left from the last", async () => {
    let spawns = 0
    const { ports, stopped } = makePorts(async () => {
      spawns += 1
      return spawns === 1 ? { agentId: "agent-1" } : { deny: "fixture denial" }
    })
    const driver = makeAgentDriver(ports)
    await started(driver)
    await started(driver, "session-2")

    driver.attach(makeClaudeHost(() => undefined, driver.send))
    // The last run's live agent leaving would free a place for its queued
    // spawn.
    driver.send({ kind: "dispose", id: OPEN.id })
    await settle()
    await driver.stopAll("run ended")

    expect(driver.activity()).toEqual([])
    expect(driver.agentIds()).toEqual([])
    expect(spawns).toBe(2)
    expect(stopped).toEqual([])
  })
})
