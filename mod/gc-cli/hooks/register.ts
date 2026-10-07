import type { EngineInterface, Register } from "claude-code"
import {
  type BuildInfo,
  createEngine,
  digestDelivery,
  type Engine,
  type EnginePorts,
  inputsStamp,
  renderStrip,
  reviewArgv,
  reviewToolArgs,
  type RunResult,
} from "../../engine.ts"

// gc-cli (#134 Idea 3): the Gauntlet review program, bundled into this mod
// as hooks/vendor/engine.js and run in process. This module is the glue the
// engine cannot be: it is the only code that may spell `$`, so it hands the
// engine closures over `$` (ports), registers /gc-cli and the agent's review
// tool, hands each digest to the main agent, relays turn endings
// and gc-cli-tools' observations, keeps the bundle fresh, and makes a
// reload that loses a run loud.
//
// Every tool and agent hook names its tool or agent: matcher-less
// tool.call/tool.check/agent.offer hooks broke other subagents (#134). The
// turn.step hook only passes through; a worktree subagent's Bash still ran
// with it loaded (Claude Code 2.1.291, #146).

type Engines = EngineInterface

const BUILD_FILE = "hooks/vendor/build.json"
const STORE_INFLIGHT = "inflight"

interface InFlight {
  readonly startedAt: number
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly runId?: string | undefined
  readonly agentIds: ReadonlyArray<string>
  readonly snapshots: ReadonlyArray<string>
}

interface TriggerRequest {
  readonly cwd: string
  readonly args: string
  readonly afterRebuild?: "stop" | "run"
}

const agentsRef = { plugin: "gc-cli", key: "agents" } as const
const eventsRef = { plugin: "gc-cli-tools", key: "events" } as const

let engine: Engine | undefined
let build: BuildInfo | undefined
let home = ""
let tick: { readonly cancel: () => void } | undefined
let markedAgents = ""
let runCwd = ""
// Dismiss clears the strip until the next review starts.
let dismissed = false
let drawn = ""
let drawnAt = 0
let pendingLog: Array<string> = []
let logWriting: Promise<unknown> = Promise.resolve()
const delivery = digestDelivery()
const loadedAt = Date.now()

const gcDir = () => `${home}/.gauntlet/gc-cli`

// Appends in batches: every session running the mod, and every reload of
// it, shares the one log, so none may rewrite it.
function log($: Engines, line: string) {
  pendingLog.push(`${new Date().toISOString()} [+${((Date.now() - loadedAt) / 1000).toFixed(1)}s] ${line}`)
  logWriting = logWriting.then(async () => {
    if (pendingLog.length === 0 || home === "") return
    const text = `${pendingLog.join("\n")}\n`
    pendingLog = []
    await $.process.run(["sh", "-c", 'mkdir -p "${1%/*}" && cat >> "$1"', "sh", `${gcDir()}/mod.log`], { stdin: text })
  }).catch(() => undefined)
}

function portsOf($: Engines, env: Record<string, string>): EnginePorts {
  return {
    read: (path) => $.fs.read(path),
    readBytes: (path) => $.fs.read(path, { as: "bytes" }).then((bytes) => bytes.base64),
    write: (path, text) => $.fs.write(path, text),
    list: (path) => $.fs.list(path),
    exists: (path) => $.fs.exists(path),
    stat: (path, resolve) => $.fs.stat(path, { resolve }),
    run: (argv, init) => $.process.run(argv, init),
    spawnProcess: (request) => $.process.spawn(request),
    env,
    stdout: () => undefined,
    stderr: () => undefined,
    fetch: (url, init) => $.http.fetch(url, init),
    register: async (spec) => {
      await $.agent.register(spec)
    },
    spawn: (request) => $.agent.spawn(request),
    resume: async (agentId, message) => {
      const sent = await $.tool.call({ tool: "SendMessage", to: agentId, message, summary: "Gauntlet corrective turn" })
      if (sent.deny !== undefined) return sent.deny
      return sent.isError === true ? String(sent.result) : undefined
    },
    stop: async (agentId) => {
      const stopped = await $.tool.call({ tool: "TaskStop", task_id: agentId })
      if (stopped.deny !== undefined) return stopped.deny
      return stopped.isError === true ? String(stopped.result) : undefined
    },
    publish: async (agentId, agent) => {
      await $.state.set({ ...agentsRef, id: agentId }, agent)
    },
    pull: async (agentId) => (await $.state.get({ ...eventsRef, id: agentId })).value ?? [],
    log: (line) => log($, line),
  }
}

async function setStatus($: Engines, text: string | undefined) {
  $.ui.status(text)
}

// The in-flight marker outlives this module: a reload (or a crashed
// session) that loses the run leaves it behind for the next load to report.
async function markInFlight($: Engines, marker: InFlight | undefined) {
  if (marker === undefined) await $.store.delete(STORE_INFLIGHT)
  else await $.store.set(STORE_INFLIGHT, marker)
}

async function reportLostRun($: Engines) {
  // SAFETY: only markInFlight writes this key, always an InFlight.
  const lost = (await $.store.get(STORE_INFLIGHT)) as InFlight | undefined
  if (lost === undefined) return
  await markInFlight($, undefined)
  const stopped: Array<string> = []
  for (const agentId of lost.agentIds) {
    const result = await $.tool.call({ tool: "TaskStop", task_id: agentId }).catch((error) => ({ deny: String(error) }))
    stopped.push(`${agentId}: ${"deny" in result && result.deny !== undefined ? `not stopped (${result.deny})` : "stopped"}`)
  }
  // The lost run's snapshot worktrees: its finalizers never ran.
  for (const snapshot of lost.snapshots) {
    const removed = await $.process.run(["git", "-C", lost.cwd, "worktree", "remove", "--force", snapshot]).catch((error) => ({ exitCode: 1, stderr: String(error) }))
    await $.process.run(["rm", "-rf", snapshot.replace(/\/worktree$/, "")]).catch(() => undefined)
    stopped.push(`${snapshot}: ${removed.exitCode === 0 ? "removed" : `not removed (${removed.stderr.trim()})`}`)
  }
  const age = Math.round((Date.now() - lost.startedAt) / 1000)
  const what = lost.runId === undefined ? `the review started ${String(age)}s ago` : `run ${lost.runId}`
  const note = `gc-cli: ${what} (${lost.argv.join(" ")}) was lost when the mod reloaded; ` +
    `its in-process state is gone. ${String(lost.agentIds.length)} orphaned agent(s) told to stop, ${String(lost.snapshots.length)} snapshot worktree(s) removed. ` +
    (lost.runId === undefined ? "Run /gc-cli again." : `Its run directory is kept; resume it with /gc-cli --resume=${lost.runId}.`)
  log($, `${note} ${stopped.join("; ")}`)
  $.ui.toast(note, { timeoutMs: 15_000 })
  await $.session.append({ message: { type: "user", content: [{ type: "text", text: note }] } }).catch((error) =>
    log($, `append failed: ${String(error)}`)
  )
}

// Redraws the strip when what it shows changed, and each half second for its
// clock and the running agents' pulse.
function redraw($: Engines) {
  if (dismissed) return
  const view = engine?.view()
  const shown = JSON.stringify(view === undefined ? null : { ...view, startedAt: 0 })
  if (shown === drawn && Date.now() - drawnAt < 500) return
  drawn = shown
  drawnAt = Date.now()
  $.ui.invalidate("ui.render")
}

function startTick($: Engines) {
  tick?.cancel()
  tick = $.clock.every(250, async () => {
    const running = engine?.running()
    if (running === undefined) return
    await engine?.poll().catch((error) => log($, `poll failed: ${String(error)}`))
    redraw($)
    const agents = running.agentIds.join(",")
    if (agents !== markedAgents) {
      markedAgents = agents
      await markInFlight($, { ...running, cwd: runCwd }).catch((error) => log($, `in-flight marker failed: ${String(error)}`))
    }
  })
}

async function finishRun($: Engines, result: RunResult, request: TriggerRequest) {
  tick?.cancel()
  tick = undefined
  drawnAt = 0
  redraw($)
  const digest = result.stdout.trim()
  const verdict = result.interrupted ? "cancelled" : result.exitCode === 0 ? "review finished" : "could not review"
  log($, `run ${verdict} exit ${String(result.exitCode)} after ${String(result.seconds)}s interrupted=${String(result.interrupted)}`)
  $.ui.toast(`gc-cli: ${verdict} after ${String(result.seconds)}s`)
  // Why it could not run or deliver, and how a run that reached no exit code
  // ended, show beside a digest too.
  const said = [...(result.refusal === undefined ? [] : [result.refusal]), ...(result.ending === undefined ? [] : [result.ending])]
  // With no digest and nothing said, a completed run resumed has the CLI's
  // own closing lines.
  const closing = said.length > 0
    ? said
    : result.stderr.trim().split("\n").filter((line) => /already complete|posted/.test(line)).slice(-3)
  const shown = digest === "" ? [`${verdict} (exit ${String(result.exitCode)})`, ...closing] : [...digest.split("\n"), ...said]
  const text = digest === ""
    ? `gc-cli: ${shown.join("\n")}`
    : `gc-cli ${verdict}:\n\n${digest}${said.length === 0 ? "" : `\n\n${said.join("\n")}`}`
  await deliver($, text, shown)
  // Bookkeeping comes after the result is shown: a failed write only logs.
  await markInFlight($, undefined).catch((error) => log($, `in-flight marker failed: ${String(error)}`))
  await $.fs.write(`${gcDir()}/last-run.json`, JSON.stringify({ ...result, request, stats: engine?.stats() }, null, 2))
    .catch((error) => log($, `last-run.json failed: ${String(error)}`))
}

// A submitted prompt shows the person its text; an appended row is the
// model's alone, so the person gets transcript rows, one per line (a row
// draws no line breaks).
async function deliver($: Engines, text: string, shown: ReadonlyArray<string>) {
  if (delivery.route(text) === "submit") {
    await submit($, text)
    return
  }
  for (const line of shown) {
    if (line.trim() !== "") $.ui.log(line)
  }
  await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }).catch((error) =>
    log($, `append failed: ${String(error)}`)
  )
}

async function submit($: Engines, text: string) {
  const submitted = await $.prompt.submit({ text }).catch((error) => ({ drop: String(error) }))
  if ("drop" in submitted) log($, `submit dropped: ${String(submitted.drop)}`)
}

// The installed Recipes this Host can run, for the review tool's description.
async function claudeRecipes($: Engines): Promise<ReadonlyArray<string>> {
  const dir = `${home}/.gauntlet/recipes`
  const entries = await $.fs.list(dir).catch(() => [])
  const found: Array<string> = []
  for (const { name } of entries) {
    if (!name.endsWith(".json")) continue
    const text = await $.fs.read(`${dir}/${name}`).catch(() => "")
    if (text.includes("claude-code/")) found.push(name.slice(0, -".json".length))
  }
  return found.sort()
}

const reviewTool = (recipes: ReadonlyArray<string>) => ({
  name: "review",
  description: "Runs a Gauntlet code review in the background, here in Claude Code: finder agents, verification and judgment over a diff, ending in a Dossier and a short digest. " +
    "Use it when asked to run Gauntlet or a Gauntlet review; it replaces running the `gauntlet` CLI from a shell. " +
    "It returns at once. The digest arrives as a message when the review finishes (minutes, not seconds): between your tool calls while you work, or as a new turn once you stop, so carry on or end your turn. One review at a time per session. " +
    "`args` is the /gc-cli syntax: a target, which is nothing for the uncommitted changes, a pull request number, or a commit range or base (`main`, `abc123..def456`); " +
    "then `--recipe <name>` for the models and effort (left out, the configured default), `--lenses a,b`, `--spec <markdown file outside the repo>`, `--resume <run id>`, `--no-related-files`. " +
    (recipes.length === 0
      ? "No Claude Code recipes are installed."
      : `Installed Claude Code recipes: ${recipes.join(", ")}; when the person names an effort or model ("gauntlet medium"), pass the recipe here that matches it.`),
  inputSchema: {
    type: "object",
    properties: { args: { type: "string", description: "The review's target and flags, as /gc-cli takes them" } },
    required: ["args"],
  },
})

async function openDossier($: Engines, path: string) {
  const opened = await $.process.run(["open", path]).catch((error) => ({ exitCode: 1, stderr: String(error) }))
  if (opened.exitCode !== 0) {
    log($, `open ${path} failed: ${opened.stderr.trim()}`)
    $.ui.toast(`gc-cli: could not open ${path}`)
  }
}

// Starts a review in the background; answers the command's one line.
async function startReview($: Engines, request: TriggerRequest): Promise<string> {
  if (engine === undefined || build === undefined) return "gc-cli: the engine did not load; see ~/.gauntlet/gc-cli/mod.log"
  const running = engine.running()
  if (running !== undefined) {
    return `gc-cli: a review is already running (${running.runId ?? "starting"}, ${String(Math.round((Date.now() - running.startedAt) / 1000))}s); one per session.`
  }
  const hashStart = Date.now()
  let fresh: Awaited<ReturnType<typeof inputsStamp>>
  try {
    fresh = await inputsStamp({ run: (argv, stdin) => $.process.run(argv, stdin === undefined ? {} : { stdin }) }, build.repoRoot)
  } catch (error) {
    log($, `stamp failed: ${String(error)}`)
    return `gc-cli: could not check the checkout for changes to the mod: ${String(error).slice(0, 300)}`
  }
  const hashMs = Date.now() - hashStart
  // The stamp on disk, not the one loaded: a rebuild whose code came out
  // byte-identical (a docs or build-script change) rewrites only build.json,
  // and the engine reloads a plugin only when its modules change.
  // SAFETY: scripts/build-mod.ts writes build.json from a BuildInfo.
  const onDisk = JSON.parse(await $.fs.read(`${$.plugin.root}/${BUILD_FILE}`)) as BuildInfo
  log($, `stamp ${fresh.stamp} over ${String(fresh.files)} files in ${String(hashMs)}ms (built ${onDisk.stamp}, loaded ${build.stamp})`)
  if (fresh.stamp !== onDisk.stamp) {
    const rebuildStart = Date.now()
    await setStatus($, "gc-cli: the checkout changed; rebuilding the mod")
    const built = await $.process.run([build.bun, "run", "build-mod", $.plugin.root.replace(/\/[^/]+$/, "")], {
      cwd: build.repoRoot,
      timeoutMs: 300_000,
    }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }))
    const rebuildMs = Date.now() - rebuildStart
    log($, `rebuild exit ${String(built.exitCode)} in ${String(rebuildMs)}ms: ${built.stdout.trim()} ${built.stderr.trim()}`)
    await setStatus($, undefined)
    if (built.exitCode !== 0) return `gc-cli: the checkout changed and the rebuild failed: ${built.stderr.trim().slice(0, 300)}`
    if (request.afterRebuild !== "run") {
      return `gc-cli: rebuilt the mod from the changed checkout in ${String(rebuildMs)}ms; it reloads in a few seconds. Start the review again.`
    }
  }
  const argv = reviewArgv(request.args)
  log($, `starting ${argv.join(" ")} in ${request.cwd}`)
  markedAgents = ""
  runCwd = request.cwd
  dismissed = false
  await markInFlight($, { startedAt: Date.now(), argv, cwd: request.cwd, agentIds: [], snapshots: [] })
  startTick($)
  void engine
    .start({ argv, cwd: request.cwd }, (line) => log($, `cli: ${line}`))
    .then((result) => finishRun($, result, request))
    .catch((error) => log($, `run failed to start: ${String(error)}`))
  return `gc-cli: review started (${argv.slice(1).join(" ")}); progress shows above the prompt, and the digest arrives as a message when it finishes.`
}

// Test runs and cancels arrive as files the mod polls (a command registered
// after an agent spawned is invisible to it).
async function checkTrigger($: Engines) {
  const path = `${gcDir()}/trigger.json`
  if (!(await $.fs.exists(path))) return
  const text = await $.fs.read(path)
  await $.process.run(["rm", "-f", path])
  // SAFETY: the trigger file is the test harness's, written as a TriggerRequest.
  const request = JSON.parse(text) as TriggerRequest & { readonly kind?: "cancel" }
  if (request.kind === "cancel") {
    log($, `cancel requested: ${String(await engine?.cancel())}`)
    return
  }
  const answer = await startReview($, request)
  log($, `trigger answered: ${answer}`)
  await $.fs.write(`${gcDir()}/trigger-answer.txt`, `${answer}\n`)
}

export const register: Register = (on) => {
  on("session.start", async ($, e, next) => {
    const started = await next(e)
    home = (await $.env.get("HOME")) ?? ""
    const env = Object.fromEntries(
      [
        ["HOME", home],
        ["TMPDIR", await $.env.get("TMPDIR")],
        ["LINEAR_API_KEY", await $.env.get("LINEAR_API_KEY")],
      ].flatMap(([name, value]) => (value === undefined ? [] : [[name, value]])),
    )
    try {
      const loadStart = Date.now()
      // SAFETY: scripts/build-mod.ts writes build.json from a BuildInfo.
      build = JSON.parse(await $.fs.read(`${$.plugin.root}/${BUILD_FILE}`)) as BuildInfo
      engine = createEngine(portsOf($, env), build)
      log($, `loaded engine ${build.stamp.slice(0, 12)} built ${build.builtAt} in ${String(Date.now() - loadStart)}ms (module loaded ${String(Date.now() - loadedAt)}ms ago)`)
    } catch (error) {
      log($, `engine failed to load: ${String(error)}`)
    }
    await $.tool.register(reviewTool(await claudeRecipes($)))
    await $.command.register({
      name: "gc-cli",
      description: "Gauntlet review, run in process: /gc-cli [target] [--recipe=…] [--lenses=…] [--spec=…] [--no-related-files]",
    })
    await reportLostRun($)
    $.clock.every(2000, () => checkTrigger($).catch((error) => log($, `trigger failed: ${String(error)}`)))
    return started
  })

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    const view = engine?.view()
    if (view === undefined || dismissed || e.props.hasSurvey) return next(e)
    return renderStrip(view, $.ui.resolve(e), { surface: e.surface, columns: e.props.bodyColumns }, Date.now(), {
      stop: () => {
        void engine?.cancel().then((cancelled) => log($, `stop pressed: ${String(cancelled)}`))
      },
      openDossier: (path) => {
        void openDossier($, path)
      },
      dismiss: () => {
        dismissed = true
        $.ui.invalidate("ui.render")
      },
    })
  })

  // The host labels the answer with the plugin's name already.
  on("command.run", { command: "gc-cli" }, async ($, e) => ({
    text: (await startReview($, { cwd: await $.session.root(), args: e.args })).replace(/^gc-cli: /, ""),
  }))

  on("tool.call", { tool: "mcp__gc-cli__review" }, async ($, e) => {
    const args = reviewToolArgs(e)
    if (args === undefined) return { deny: "review takes `args`, a string: the target and flags as /gc-cli takes them." }
    const answer = await startReview($, { cwd: await $.session.root(), args })
    return { result: answer.replace(/^gc-cli: /, "") }
  })

  // The main agent's turns (no agentId), so a digest knows whether it would
  // land in a running turn.
  on("turn.start", ($, e, next) => {
    delivery.turnStarted()
    return next(e)
  })
  on("turn.step", async function* ($, e, next) {
    if (e.agentId === undefined) delivery.stepped()
    return yield* next(e)
  })

  // Every turn of every loop passes here; only this run's agents are taken.
  on("turn.complete", async ($, e, next) => {
    if (e.agentId === undefined) {
      const unread = delivery.turnEnded()
      if (unread !== undefined) void submit($, unread)
    }
    if (engine !== undefined && e.agentId !== undefined) {
      await engine.turnComplete({
        agentId: e.agentId,
        reason: e.reason,
        answer: e.answer,
        usage: e.usage,
        refusal: e.reason === "refusal" ? { explanation: e.refusal.explanation ?? undefined } : undefined,
      })
    }
    return next(e)
  })

  // This mod's own resume and stop calls need no prompt.
  on("tool.check", { tool: "SendMessage" }, ($, e, next) => (next.origin?.plugin === "gc-cli" ? { decision: "allow" } : next(e)))
  on("tool.check", { tool: "TaskStop" }, ($, e, next) => (next.origin?.plugin === "gc-cli" ? { decision: "allow" } : next(e)))

  // Hidden from the model except while the engine's SendMessage resumes one.
  on("agent.offer", { agent: "gc-cli:gc-slot-1" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gc-cli:gc-slot-2" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gc-cli:gc-slot-3" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gc-cli:gc-slot-4" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gc-cli:gc-slot-5" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gc-cli:gc-slot-6" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gc-cli:gc-slot-7" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gc-cli:gc-slot-8" }, () => ({ isOffered: engine?.isOffering() === true }))
}
