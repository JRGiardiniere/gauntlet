import type { EngineInterface, Register, ToolCallResult, ToolCheckResult, TurnStepResult } from "claude-code"
import type { GauntletToolsEvent, GauntletToolsJson } from "../types/index.d.ts"
import { checkEmit, emitTools, FENCED_TOOLS, fencedInputOf, fencedPathOf, isInsideRoot } from "../../tools-core.ts"

// gauntlet-tools (#134 Idea 3): what must see the gauntlet plugin's agents. Agents skip
// the hooks of the plugin that spawned them, so the gauntlet plugin cannot answer its
// own agents' emit tools or watch their reads. This plugin serves the emit
// tools with the review program's strict decoders, records each agent's tool
// calls, emits and responses in its own state (the Mod's engine reads them in
// order), and fences Read/Grep/Glob to the agent's review snapshot.
//
// Every hook names its tool: matcher-less tool.call/tool.check hooks break
// other subagents.

type Engines = EngineInterface

// What the gauntlet plugin publishes per agent (its contract, gauntlet/types, is the
// definition; a plugin may import only its own files).
interface PublishedAgent {
  readonly invocation: string
  readonly emitTool: string
  readonly root: string
}

const agentsRef = { plugin: "gauntlet", key: "agents" } as const
const eventsRef = { plugin: "gauntlet-tools", key: "events" } as const

const logs = new Map<string, Array<GauntletToolsEvent>>()
const writing = new Map<string, Promise<unknown>>()
const byToolUse = new Map<string, PublishedAgent>()

async function agentOf($: Engines, agentId: string | undefined): Promise<PublishedAgent | undefined> {
  if (agentId === undefined) return undefined
  return (await $.state.get({ ...agentsRef, id: agentId })).value
}

// Appends to one agent's log, in call order. The log is the host's: a
// reload of this plugin picks it up where it stood. A write that fails
// rejects and leaves the log as it was; later writes carry on.
function record($: Engines, agentId: string, event: GauntletToolsEvent) {
  const previous = writing.get(agentId) ?? Promise.resolve()
  const next = previous.then(async () => {
    let log = logs.get(agentId)
    if (log === undefined) {
      log = [...((await $.state.get({ ...eventsRef, id: agentId })).value ?? [])]
      logs.set(agentId, log)
    }
    await $.state.set({ ...eventsRef, id: agentId }, [...log, event])
    log.push(event)
  })
  writing.set(agentId, next.catch(() => undefined))
  return next
}

// A tool event only feeds the run view, which does without a lost one.
function recordQuietly($: Engines, agentId: string, event: GauntletToolsEvent) {
  record($, agentId, event).catch(() => undefined)
}

interface ToolEnvelope {
  readonly tool: string
  readonly agentId?: string | undefined
  readonly tool_use_id?: string | undefined
}

// A tool call's arguments, the envelope fields taken off.
function argsOf(e: ToolEnvelope): GauntletToolsJson {
  // SAFETY: a tool call's input is the JSON the model sent, parsed by the
  // engine from the tool_use block; only the envelope fields are not JSON input.
  const { agentId: _agent, tool: _tool, tool_use_id: _use, ...args } = e as ToolEnvelope & Record<string, GauntletToolsJson>
  return args
}

async function serveEmit($: Engines, e: ToolEnvelope, name: string) {
  const agent = await agentOf($, e.agentId)
  if (agent === undefined || e.agentId === undefined || agent.emitTool !== e.tool) {
    return { deny: `${name} serves only Gauntlet invocation agents.` }
  }
  const args = argsOf(e)
  const rejection = checkEmit(name, args)
  // An emit the engine never sees is no emit: the agent is told to send it
  // again rather than told it was recorded.
  const unrecorded = await record($, e.agentId, { type: "emit", args, accepted: rejection === undefined })
    .then(() => undefined, String)
  if (rejection !== undefined) return { deny: rejection }
  if (unrecorded !== undefined) return { deny: `${name} could not be recorded (${cut(unrecorded, 200)}); call it again with the same arguments.` }
  return { result: "Recorded. Your work is complete: reply with the single word DONE." }
}

function cut(text: string, length: number) {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

async function trackTool<E extends ToolEnvelope>($: Engines, e: E, next: (e: E) => Promise<ToolCallResult>): Promise<ToolCallResult> {
  const agent = await agentOf($, e.agentId)
  if (agent === undefined || e.agentId === undefined) return next(e)
  const agentId = e.agentId
  if (e.tool_use_id !== undefined) byToolUse.set(e.tool_use_id, agent)
  recordQuietly($, agentId, { type: "tool_start", toolName: e.tool, args: argsOf(e) })
  const result = await next(e)
  const isError = result.deny !== undefined || result.isError === true
  recordQuietly(
    $,
    agentId,
    isError
      ? { type: "tool_end", toolName: e.tool, isError, detail: cut(String(result.deny ?? result.result), 500) }
      : { type: "tool_end", toolName: e.tool, isError },
  )
  return result
}

// ReviewWorkspace confinement: Read/Grep/Glob outside the snapshot are denied.
async function fence<E extends { readonly tool: string; readonly tool_use_id?: string | undefined; readonly input: unknown }>(
  $: Engines,
  e: E,
  next: (e: E) => Promise<ToolCheckResult>,
): Promise<ToolCheckResult> {
  const agent = e.tool_use_id === undefined ? undefined : byToolUse.get(e.tool_use_id)
  if (agent === undefined) return next(e)
  const path = fencedPathOf(e.tool, fencedInputOf(e.input), agent.root)
  const [stat, root] = await Promise.all([
    path === undefined ? undefined : $.fs.stat(path, { resolve: true }).catch(() => undefined),
    $.fs.stat(agent.root, { resolve: true }).catch(() => undefined),
  ])
  if (FENCED_TOOLS.some((tool) => tool === e.tool) && isInsideRoot(stat?.realPath, root?.realPath ?? agent.root)) {
    // Inside: the chain beneath decides, as for any read in the agent's cwd.
    return next(e)
  }
  return { decision: "deny", reason: `${String(path)} is outside the review snapshot ${agent.root}.` }
}

// Each response of an agent the gauntlet plugin published goes to the engine
// as it arrives, with Claude's own stop reason and its request's usage; the
// last one before the turn ends is the invocation's terminal evidence. It is
// recorded before the step returns, so the engine has it once the turn ends.
// A step with no response (a null stop reason) reports nothing.
async function recordStep($: Engines, agentId: string | undefined, step: TurnStepResult) {
  if (step.stopReason === null || agentId === undefined || (await agentOf($, agentId)) === undefined) return
  await record($, agentId, { type: "message_end", stopReason: step.stopReason, usage: step.usage }).catch(() => undefined)
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    for (const tool of emitTools) await $.tool.register(tool)
    return started
  })

  on("tool.call", { tool: "mcp__gauntlet-tools__emit_findings" }, ($, e) => serveEmit($, e, "emit_findings"))
  on("tool.call", { tool: "mcp__gauntlet-tools__emit_pool" }, ($, e) => serveEmit($, e, "emit_pool"))
  on("tool.call", { tool: "mcp__gauntlet-tools__emit_verdicts" }, ($, e) => serveEmit($, e, "emit_verdicts"))
  on("tool.call", { tool: "mcp__gauntlet-tools__emit_judgments" }, ($, e) => serveEmit($, e, "emit_judgments"))

  on("tool.call", { tool: "Read" }, ($, e, next) => trackTool($, e, next))
  on("tool.call", { tool: "Grep" }, ($, e, next) => trackTool($, e, next))
  on("tool.call", { tool: "Glob" }, ($, e, next) => trackTool($, e, next))

  on("tool.check", { tool: "Read" }, ($, e, next) => fence($, e, next))
  on("tool.check", { tool: "Grep" }, ($, e, next) => fence($, e, next))
  on("tool.check", { tool: "Glob" }, ($, e, next) => fence($, e, next))

  // Every other loop's step passes through unchanged.
  on("turn.step", async function* ($, e, next) {
    const step = yield* next(e)
    await recordStep($, e.agentId, step)
    return step
  })
}
