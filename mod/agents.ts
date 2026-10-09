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

// One invocation's life in the driver, from its open to the end of the run.
// `state` is a plain field; each handler knows which state it moves from. A
// disposed record stays for the strip, and nothing acts on it again.
interface Invocation extends AgentActivity {
  readonly type: string
  readonly emitTool: string
  readonly cwd: string
  // The turn-0 prompt, kept so that a refused spawn can be retried.
  firstPrompt: string
  agentId?: string
  consumed: number
  emitAccepted: boolean
  disposed: boolean
  // When it last joined the spawn queue.
  waitingSince: number
}

type PromptCommand = Extract<ClaudeHostCommand, { readonly kind: "prompt" }>

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
  // This run's invocations, in open order.
  const invocations = new Map<string, Invocation>()
  // This run's slot for each agent type, and the slot's registration.
  const slots = new Map<string, { readonly number: number; readonly ready: Promise<void> }>()
  // The definition last registered under each slot name. It outlives a run,
  // so a slot whose definition is unchanged is not registered again.
  const registered = new Map<string, string>()
  let offering = 0
  let retry: ReturnType<typeof setTimeout> | undefined

  const current = () => [...invocations.values()].filter((invocation) => !invocation.disposed)
  // This run's spawned agents hold places under the at-once cap until their
  // sessions are disposed.
  const live = () => current().filter((invocation) => invocation.agentId !== undefined).length

  // A new run starts its slot numbering over, and nothing of the last run's
  // invocations or queued spawns carries into it.
  const attach = (core: ClaudeHost) => {
    host = core
    invocations.clear()
    slots.clear()
    clearTimeout(retry)
    retry = undefined
  }

  // Re-registering a live type is not atomic: a slot is registered only when
  // its definition changed, and its first spawn waits for that.
  const register = async (number: number, definition: Pick<AgentTypeSpec, "prompt" | "tools" | "model" | "effort">) => {
    const spec: AgentTypeSpec = {
      name: `slot-${String(number)}`,
      description: "Gauntlet invocation agent; only the Mod spawns it.",
      ...definition,
      permissionMode: "default",
      omitClaudeMd: true,
    }
    const text = JSON.stringify(spec)
    if (registered.get(spec.name) === text) return
    await ports.register(spec)
    registered.set(spec.name, text)
    ports.log(`registered ${spec.name} (${spec.model}:${spec.effort}, tools ${spec.tools.join(",")})`)
  }

  const open = async (command: Extract<ClaudeHostCommand, { readonly kind: "open" }>) => {
    const { effort, model } = seatParts(command.seat)
    const emitTool = `mcp__${TOOLS_PLUGIN}__${command.emitTool.name}`
    const tools = command.tools.length > 0 ? [...READ_TOOLS, emitTool] : [emitTool]
    const key = `${command.seat}\u0000${tools.join(",")}\u0000${command.systemPrompt}`
    // The slot is reserved and the record inserted before any await: Pool and
    // Judgment open at once and must never share a slot number, and the host
    // disposes an open it stops waiting for, which must find the record.
    let slot = slots.get(key)
    if (slot === undefined) {
      const number = slots.size + 1
      if (number > AGENT_SLOTS) {
        host?.opened(command.id, `more than ${String(AGENT_SLOTS)} agent types in one run`)
        return
      }
      slot = { number, ready: register(number, { prompt: command.systemPrompt, tools, model, effort }) }
      slots.set(key, slot)
    }
    const invocation: Invocation = {
      id: command.id,
      invocationId: command.invocationId,
      state: "opening",
      type: `${SPAWNER_PLUGIN}:slot-${String(slot.number)}`,
      emitTool,
      cwd: command.cwd,
      firstPrompt: "",
      consumed: 0,
      emitAccepted: false,
      disposed: false,
      waitingSince: 0,
    }
    invocations.set(command.id, invocation)
    const failure = await slot.ready.then(() => undefined, String)
    if (invocation.disposed) return
    if (failure !== undefined) {
      ports.log(`open ${command.id} failed: ${failure}`)
      invocation.state = "failed"
    }
    host?.opened(command.id, failure)
  }

  // Every turn's ending goes through here. A disposed record's session is
  // gone, so an await that resumes after the dispose reports nothing.
  const end = (invocation: Invocation, ending: ClaudeTurnEnding) => {
    if (invocation.disposed) return
    invocation.state = ending.reason === "aborted" ? "stopped" : ending.reason === "error" || ending.reason === "refusal" ? "failed" : "answered"
    host?.ended(invocation.id, ending)
  }

  // The spawn queue is the records waiting, retried in the order they joined
  // it: a spawn refused again goes to the back, behind the others waiting.
  const scheduleRetry = () => {
    if (retry !== undefined || !current().some((invocation) => invocation.state === "waiting")) return
    retry = setTimeout(() => {
      retry = undefined
      drain()
    }, 2000)
  }

  const drain = () => {
    const [next] = current().filter((invocation) => invocation.state === "waiting").sort((a, b) => a.waitingSince - b.waitingSince)
    if (next === undefined) return
    ports.log(`dequeued ${next.id} after ${String(Date.now() - next.waitingSince)}ms (live ${String(live())})`)
    next.state = "opening"
    void spawn(next)
    scheduleRetry()
  }

  const spawn = async (invocation: Invocation) => {
    try {
      const spawned = await ports.spawn({
        subagentType: invocation.type,
        prompt: invocation.firstPrompt,
        description: `gauntlet ${invocation.invocationId.replace(/^\d{4}-\S+?Z-[0-9a-f]+-/, "")}`.slice(0, 60),
        cwd: invocation.cwd,
      })
      if (spawned.agentId !== undefined) invocation.agentId = spawned.agentId
      if (invocation.disposed) {
        await stop(invocation, "disposed while spawning")
        return
      }
      if (invocation.agentId === undefined) {
        const deny = spawned.deny ?? "no agent id"
        // With none of this run's agents live, the denial cannot be the
        // at-once cap: no place will free up, so the invocation ends now.
        if (live() === 0) {
          ports.log(`spawn ${invocation.id} refused with no agent live: ${deny}`)
          end(invocation, { reason: "error", detail: `spawn refused: ${deny}` })
          return
        }
        ports.log(`spawn ${invocation.id} refused (live ${String(live())}): ${deny}; queued`)
        invocation.state = "waiting"
        invocation.waitingSince = Date.now()
        scheduleRetry()
        return
      }
      invocation.state = "running"
      await ports.publish(invocation.agentId, { invocation: invocation.id, emitTool: invocation.emitTool, root: invocation.cwd })
      ports.log(`spawned ${invocation.id} -> ${invocation.agentId} (${spawned.model ?? "?"}) live ${String(live())}`)
    } catch (error) {
      ports.log(`spawn ${invocation.id} rejected: ${String(error)}`)
      end(invocation, { reason: "error", detail: `spawn rejected: ${String(error)}` })
    }
  }

  const prompt = async (command: PromptCommand) => {
    const invocation = invocations.get(command.id)
    if (invocation === undefined || invocation.disposed) return
    if (command.turn === 0) {
      invocation.firstPrompt = command.text
      return spawn(invocation)
    }
    if (invocation.agentId === undefined) return
    invocation.state = "running"
    // Resume is gated by agent.offer, which offers the hidden type only while
    // this send is in flight.
    offering += 1
    try {
      const refused = await ports.resume(invocation.agentId, command.text)
      ports.log(`corrective turn ${String(command.turn)} for ${command.id}${refused === undefined ? "" : ` refused: ${cut(refused)}`}`)
      if (refused !== undefined) end(invocation, { reason: "error", detail: `corrective turn refused: ${refused}` })
    } catch (error) {
      end(invocation, { reason: "error", detail: `corrective turn rejected: ${String(error)}` })
    } finally {
      offering -= 1
    }
  }

  // A queued spawn has no agent to stop: leaving the queue ends its turn.
  const stop = async (invocation: Invocation, why: string) => {
    if (invocation.state === "waiting") {
      end(invocation, { reason: "aborted" })
      return
    }
    if (invocation.agentId === undefined) return
    const refused = await ports.stop(invocation.agentId).catch(String)
    ports.log(`TaskStop ${invocation.id} (${why})${refused === undefined ? "" : `: ${cut(refused)}`}`)
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
        const invocation = invocations.get(command.id)
        if (invocation !== undefined && !invocation.disposed) void stop(invocation, "abort")
        return
      }
      case "dispose": {
        const invocation = invocations.get(command.id)
        if (invocation === undefined || invocation.disposed) return
        // A session disposed before its turn ended is an interrupted run, and
        // nothing would stop its subagent once the record is disposed. An
        // answered or failed one keeps its ending.
        if (invocation.state === "running") void stop(invocation, "disposed")
        if (["opening", "waiting", "running"].includes(invocation.state)) invocation.state = "stopped"
        invocation.disposed = true
        // Its agent's place under the cap is free.
        if (invocation.agentId !== undefined) drain()
      }
    }
  }

  // Applies gauntlet-tools' new log entries for one agent, in order.
  const absorb = async (invocation: Invocation) => {
    if (invocation.agentId === undefined) return
    const events = await ports.pull(invocation.agentId)
    if (invocation.disposed) return
    for (const event of events.slice(invocation.consumed)) {
      invocation.consumed += 1
      if (event.type === "emit") {
        const answer = host?.emit(invocation.id, event.args)
        if (answer?.ok === true) {
          invocation.emitAccepted = true
          const items = itemCount(event.args)
          if (items !== undefined) invocation.items = items
        }
        if (answer !== undefined && answer.ok !== event.accepted) {
          ports.log(`emit verdicts disagree for ${invocation.id}: tools ${String(event.accepted)}, engine ${String(answer.ok)}`)
        }
        continue
      }
      host?.event(invocation.id, event)
    }
  }

  const poll = async () => {
    for (const invocation of current()) await absorb(invocation)
  }

  // Answers whether the turn was one of this run's agents.
  const turnComplete = async (e: TurnComplete) => {
    const invocation = e.agentId === undefined ? undefined : current().find((each) => each.agentId === e.agentId)
    if (invocation === undefined) return false
    // The ending still reaches the host when the pull fails: a missed emit
    // is a missing emit, not a turn that never ends.
    await absorb(invocation).catch((error) => ports.log(`pull ${invocation.id} failed: ${String(error)}`))
    let detail: string | undefined
    if (e.reason === "refusal") detail = e.refusal?.explanation ?? "refusal"
    if (e.reason === "error") detail = e.answer
    ports.log(`turn ${invocation.id} ${e.reason} emit=${String(invocation.emitAccepted)} usage=${e.usage === undefined ? "none" : JSON.stringify(e.usage)}`)
    if (e.reason === "answer") {
      host?.event(invocation.id, {
        type: "message_end",
        stopReason: invocation.emitAccepted ? "tool_use" : "end_turn",
        usage: e.usage ?? null,
      })
    }
    // An unanswered turn's spend rides on its ending (an aborted turn's
    // requests still cost); an answer reported it through message_end.
    end(invocation, { reason: e.reason, usage: e.reason === "answer" ? undefined : e.usage, detail })
    return true
  }

  const stopAll = async (why: string) => {
    clearTimeout(retry)
    retry = undefined
    for (const invocation of current()) await stop(invocation, why)
  }

  return {
    attach,
    send,
    poll,
    turnComplete,
    stopAll,
    isOffering: () => offering > 0,
    agentIds: () => current().flatMap((invocation) => (invocation.agentId === undefined ? [] : [invocation.agentId])),
    // This run's invocations in open order, copied for the strip.
    activity: (): ReadonlyArray<AgentActivity> =>
      [...invocations.values()].map(({ id, invocationId, items, state }) => ({ id, invocationId, state, items })),
  }
}
