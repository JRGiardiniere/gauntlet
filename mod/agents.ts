// The Claude agents behind the in-process Claude host (#134 Idea 3): carries
// out the host core's commands with Claude Code's agent API and feeds the
// core what the hooks saw. Each open registers (or reuses) a hidden agent
// type keyed by Seat, tool set and system prompt, so siblings share a cached
// prefix; turn 0 spawns, a corrective turn resumes through SendMessage, an
// abort is TaskStop. Spawns refused at Claude Code's at-once cap (20
// subagents per session, other agents included) wait for a free place.
//
// Agents skip the hooks of the plugin that spawned them, so gauntlet-tools
// serves their emit tools, watches their reads and fences them. The agent
// registry it reads is published through `publish`; what it saw comes back
// through `pull`, an append-only log per agent.
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type {
  ClaudeHost,
  ClaudeHostCommand,
  ClaudeTurnEnding,
  ClaudeUsage,
} from "../src/harness/claude-host.ts"
import type { GauntletAgent } from "./gauntlet/types/index.d.ts"
import type { GauntletToolsEvent, GauntletToolsJson } from "./gauntlet-tools/types/index.d.ts"

export const SPAWNER_PLUGIN = "gauntlet"
export const TOOLS_PLUGIN = "gauntlet-tools"
export const AGENT_SLOTS = 8
const READ_TOOLS = ["Read", "Grep", "Glob"]

export interface AgentTypeSpec {
  readonly name: string
  readonly description: string
  readonly prompt: string
  readonly tools: ReadonlyArray<string>
  readonly model: string
  readonly effort: string
  readonly permissionMode: "default"
  readonly omitClaudeMd: true
}

export interface SpawnAnswer {
  readonly agentId?: string | undefined
  readonly model?: string | undefined
  readonly deny?: string | undefined
}

// What gauntlet-tools needs to serve one agent, and what it saw of one; the
// plugin state contracts are their one definition.
export type PublishedAgent = GauntletAgent
export type ToolsEvent = GauntletToolsEvent

export interface AgentPorts {
  readonly register: (spec: AgentTypeSpec) => Promise<void>
  readonly spawn: (request: {
    readonly subagentType: string
    readonly prompt: string
    readonly description: string
    readonly cwd: string
  }) => Promise<SpawnAnswer>
  // SendMessage to a finished agent; answers the refusal, if any.
  readonly resume: (agentId: string, message: string) => Promise<string | undefined>
  readonly stop: (agentId: string) => Promise<string | undefined>
  readonly publish: (agentId: string, agent: PublishedAgent) => Promise<void>
  readonly pull: (agentId: string) => Promise<ReadonlyArray<ToolsEvent>>
  readonly log: (line: string) => void
}

export interface TurnComplete {
  readonly agentId?: string | undefined
  readonly reason: "answer" | "aborted" | "refusal" | "error"
  readonly answer: string
  readonly usage?: ClaudeUsage | undefined
  readonly refusal?: { readonly explanation?: string | undefined } | undefined
}

// What the strip shows of one invocation: kept after its agent is disposed,
// for the run's life.
export interface AgentActivity {
  readonly id: string
  readonly invocationId: string
  state: "opening" | "waiting" | "running" | "answered" | "failed" | "stopped"
  // The accepted emit's item count (findings, verdicts, decisions).
  items?: number
}

interface Agent {
  readonly id: string
  readonly invocationId: string
  readonly type: string
  readonly emitTool: string
  readonly cwd: string
  agentId?: string
  consumed: number
  emitAccepted: boolean
}

type PromptCommand = Extract<ClaudeHostCommand, { readonly kind: "prompt" }>

// A turn's ending as it is assembled from turn.complete.
interface TurnEnding {
  reason: ClaudeTurnEnding["reason"]
  usage?: ClaudeUsage
  detail?: string
}

// An accepted emit's items, under its contract's one list field.
const EmitItems = Schema.Struct({
  findings: Schema.optional(Schema.Array(Schema.Unknown)),
  clusters: Schema.optional(Schema.Array(Schema.Unknown)),
  verdicts: Schema.optional(Schema.Array(Schema.Unknown)),
  decisions: Schema.optional(Schema.Array(Schema.Unknown)),
})

const itemCount = (args: GauntletToolsJson) =>
  Option.getOrUndefined(
    Option.map(
      Schema.decodeUnknownOption(EmitItems)(args),
      (items) => (items.findings ?? items.clusters ?? items.verdicts ?? items.decisions)?.length,
    ),
  )

const cut = (text: string, length = 200) => (text.length > length ? `${text.slice(0, length)}…` : text)

// "claude-code/sonnet:low" → model "sonnet", effort "low".
const seatParts = (seat: string) => {
  const rest = seat.slice(seat.indexOf("/") + 1)
  const colon = rest.lastIndexOf(":")
  return { model: rest.slice(0, colon), effort: rest.slice(colon + 1) }
}

export const makeAgentDriver = (ports: AgentPorts) => {
  let host: ClaudeHost | undefined
  const agents = new Map<string, Agent>()
  const byAgentId = new Map<string, Agent>()
  const slotOf = new Map<string, number>()
  const registered = new Map<string, string>()
  const registering = new Map<number, Promise<void>>()
  const waiting: Array<{ readonly command: PromptCommand; readonly since: number }> = []
  const activities = new Map<string, AgentActivity>()
  let offering = 0
  let live = 0
  let retry: ReturnType<typeof setTimeout> | undefined

  // Each run starts its slot numbering over; a slot is re-registered only
  // when its definition changed.
  const attach = (core: ClaudeHost) => {
    host = core
    activities.clear()
    slotOf.clear()
    registering.clear()
  }

  const open = async (command: Extract<ClaudeHostCommand, { readonly kind: "open" }>) => {
    const { effort, model } = seatParts(command.seat)
    const emitTool = `mcp__${TOOLS_PLUGIN}__${command.emitTool.name}`
    const tools = command.tools.length > 0 ? [...READ_TOOLS, emitTool] : [emitTool]
    const key = `${command.seat}\u0000${tools.join(",")}\u0000${command.systemPrompt}`
    try {
      // Reserve the slot before any await: Pool and Judgment open at once
      // and must never share a slot number.
      let slot = slotOf.get(key)
      if (slot === undefined) {
        slot = slotOf.size + 1
        if (slot > AGENT_SLOTS) {
          host?.opened(command.id, `more than ${String(AGENT_SLOTS)} agent types in one run`)
          return
        }
        slotOf.set(key, slot)
        const spec: AgentTypeSpec = {
          name: `slot-${String(slot)}`,
          description: "Gauntlet invocation agent; only the Mod spawns it.",
          prompt: command.systemPrompt,
          tools,
          model,
          effort,
          permissionMode: "default",
          omitClaudeMd: true,
        }
        const text = JSON.stringify(spec)
        // Re-registering a live type is not atomic: register a slot only when
        // its definition changed, and await it before the first spawn.
        if (registered.get(spec.name) !== text) {
          registering.set(
            slot,
            ports.register(spec).then(() => {
              registered.set(spec.name, text)
              ports.log(`registered ${spec.name} (${model}:${effort}, tools ${tools.join(",")})`)
            }),
          )
        }
      }
      await registering.get(slot)
      activities.set(command.id, {
        id: command.id,
        invocationId: command.invocationId,
        state: "opening",
      })
      agents.set(command.id, {
        id: command.id,
        invocationId: command.invocationId,
        type: `${SPAWNER_PLUGIN}:slot-${String(slot)}`,
        emitTool,
        cwd: command.cwd,
        consumed: 0,
        emitAccepted: false,
      })
      host?.opened(command.id, undefined)
    } catch (error) {
      ports.log(`open ${command.id} failed: ${String(error)}`)
      host?.opened(command.id, String(error))
    }
  }

  const end = (id: string, ending: ClaudeTurnEnding) => {
    const activity = activities.get(id)
    if (activity !== undefined) {
      activity.state = ending.reason === "aborted" ? "stopped" : ending.reason === "error" || ending.reason === "refusal" ? "failed" : "answered"
    }
    host?.ended(id, ending)
  }

  const scheduleRetry = () => {
    if (retry !== undefined || waiting.length === 0) return
    retry = setTimeout(() => {
      retry = undefined
      drain()
    }, 2000)
  }

  const spawn = async (command: PromptCommand) => {
    const agent = agents.get(command.id)
    if (agent === undefined) return
    try {
      const spawned = await ports.spawn({
        subagentType: agent.type,
        prompt: command.text,
        description: `gauntlet ${agent.invocationId.replace(/^\d{4}-\S+?Z-[0-9a-f]+-/, "")}`.slice(0, 60),
        cwd: agent.cwd,
      })
      if (spawned.agentId === undefined) {
        const deny = spawned.deny ?? "no agent id"
        // With none of this run's agents live, the denial cannot be the
        // at-once cap: no place will free up, so the invocation ends now.
        if (live === 0) {
          ports.log(`spawn ${command.id} refused with no agent live: ${deny}`)
          end(command.id, { reason: "error", detail: `spawn refused: ${deny}` })
          return
        }
        ports.log(`spawn ${command.id} refused (live ${String(live)}): ${deny}; queued`)
        waiting.push({ command, since: Date.now() })
        const activity = activities.get(command.id)
        if (activity !== undefined) activity.state = "waiting"
        scheduleRetry()
        return
      }
      agent.agentId = spawned.agentId
      if (!agents.has(command.id)) {
        // Disposed while the spawn was in flight.
        await stop(agent, "disposed while spawning")
        return
      }
      const activity = activities.get(command.id)
      if (activity !== undefined) activity.state = "running"
      byAgentId.set(spawned.agentId, agent)
      live += 1
      await ports.publish(spawned.agentId, { invocation: agent.id, emitTool: agent.emitTool, root: agent.cwd })
      ports.log(`spawned ${command.id} -> ${spawned.agentId} (${spawned.model ?? "?"}) live ${String(live)}`)
    } catch (error) {
      ports.log(`spawn ${command.id} rejected: ${String(error)}`)
      end(command.id, { reason: "error", detail: `spawn rejected: ${String(error)}` })
    }
  }

  const drain = () => {
    const next = waiting.shift()
    if (next === undefined) return
    ports.log(`dequeued ${next.command.id} after ${String(Date.now() - next.since)}ms (live ${String(live)})`)
    void spawn(next.command)
    scheduleRetry()
  }

  const prompt = async (command: PromptCommand) => {
    if (command.turn === 0) return spawn(command)
    const agent = agents.get(command.id)
    if (agent?.agentId === undefined) return
    const activity = activities.get(command.id)
    if (activity !== undefined) activity.state = "running"
    // Resume is gated by agent.offer, which offers the hidden type only while
    // this send is in flight.
    offering += 1
    try {
      const refused = await ports.resume(agent.agentId, command.text)
      ports.log(`corrective turn ${String(command.turn)} for ${command.id}${refused === undefined ? "" : ` refused: ${cut(refused)}`}`)
      if (refused !== undefined) end(command.id, { reason: "error", detail: `corrective turn refused: ${refused}` })
    } catch (error) {
      end(command.id, { reason: "error", detail: `corrective turn rejected: ${String(error)}` })
    } finally {
      offering -= 1
    }
  }

  const stop = async (agent: Agent, why: string) => {
    const queued = waiting.findIndex((entry) => entry.command.id === agent.id)
    if (queued !== -1) {
      waiting.splice(queued, 1)
      end(agent.id, { reason: "aborted" })
      return
    }
    if (agent.agentId === undefined) return
    const refused = await ports.stop(agent.agentId).catch(String)
    ports.log(`TaskStop ${agent.id} (${why})${refused === undefined ? "" : `: ${cut(refused)}`}`)
  }

  const send = (command: ClaudeHostCommand) => {
    switch (command.kind) {
      case "open": {
        void open(command)
        return
      }
      case "prompt": {
        void prompt(command)
        return
      }
      case "abort": {
        const agent = agents.get(command.id)
        if (agent !== undefined) void stop(agent, "abort")
        return
      }
      case "dispose": {
        const agent = agents.get(command.id)
        if (agent === undefined) return
        agents.delete(command.id)
        // A session disposed mid-turn is an interrupted run; nothing would
        // stop its subagent once it leaves the registry.
        const state = activities.get(command.id)?.state
        if (state === "running" || state === "waiting") void stop(agent, "disposed")
        if (agent.agentId !== undefined) {
          live -= 1
          drain()
        }
      }
    }
  }

  // Applies gauntlet-tools' new log entries for one agent, in order.
  const absorb = async (agent: Agent) => {
    if (agent.agentId === undefined) return
    const events = await ports.pull(agent.agentId)
    const activity = activities.get(agent.id)
    for (const event of events.slice(agent.consumed)) {
      agent.consumed += 1
      if (event.type === "emit") {
        const answer = host?.emit(agent.id, event.args)
        if (answer?.ok === true) {
          agent.emitAccepted = true
          const items = itemCount(event.args)
          if (activity !== undefined && items !== undefined) activity.items = items
        }
        if (answer !== undefined && answer.ok !== event.accepted) {
          ports.log(`emit verdicts disagree for ${agent.id}: tools ${String(event.accepted)}, engine ${String(answer.ok)}`)
        }
        continue
      }
      host?.event(agent.id, event)
    }
  }

  const poll = async () => {
    for (const agent of agents.values()) await absorb(agent)
  }

  // Answers whether the turn was one of this run's agents.
  const turnComplete = async (e: TurnComplete) => {
    const agent = e.agentId === undefined ? undefined : byAgentId.get(e.agentId)
    if (agent === undefined || !agents.has(agent.id)) return false
    // The ending still reaches the host when the pull fails: a missed emit
    // is a missing emit, not a turn that never ends.
    await absorb(agent).catch((error) => ports.log(`pull ${agent.id} failed: ${String(error)}`))
    let detail: string | undefined
    if (e.reason === "refusal") detail = e.refusal?.explanation ?? "refusal"
    if (e.reason === "error") detail = e.answer
    ports.log(`turn ${agent.id} ${e.reason} emit=${String(agent.emitAccepted)} usage=${e.usage === undefined ? "none" : JSON.stringify(e.usage)}`)
    if (e.reason === "answer") {
      host?.event(agent.id, {
        type: "message_end",
        stopReason: agent.emitAccepted ? "tool_use" : "end_turn",
        usage: e.usage ?? null,
      })
    }
    // An unanswered turn's spend rides on its ending (an aborted turn's
    // requests still cost); an answer reported it through message_end.
    const ending: TurnEnding = { reason: e.reason }
    if (e.reason !== "answer" && e.usage !== undefined) ending.usage = e.usage
    if (detail !== undefined) ending.detail = detail
    end(agent.id, ending)
    return true
  }

  const stopAll = async (why: string) => {
    for (const agent of agents.values()) await stop(agent, why)
  }

  return {
    attach,
    send,
    poll,
    turnComplete,
    stopAll,
    isOffering: () => offering > 0,
    agentIds: () => [...agents.values()].flatMap((agent) => (agent.agentId === undefined ? [] : [agent.agentId])),
    stats: () => ({ live, waiting: waiting.length }),
    // This run's invocations in open order, copied for the strip.
    activity: (): ReadonlyArray<AgentActivity> => [...activities.values()].map((activity) => ({ ...activity })),
  }
}

export type AgentDriver = ReturnType<typeof makeAgentDriver>
