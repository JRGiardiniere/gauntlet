import type { EngineInterface, Register } from "claude-code"
import { type BuildInfo, createEngine, type Engine, type EnginePorts, inputsStamp, type RunResult } from "../../engine.ts"

// gc-cli (#134 Idea 3): the Gauntlet review program, bundled into this mod
// as hooks/vendor/engine.js and run in process. This module is the glue the
// engine cannot be: it is the only code that may spell `$`, so it hands the
// engine closures over `$` (ports), registers /gc-cli, relays turn endings
// and gc-cli-tools' observations, keeps the bundle fresh, and makes a
// reload that loses a run loud.
//
// Every tool and agent hook names its tool or agent: matcher-less
// tool.call/tool.check/turn.step/agent.offer hooks break other subagents.

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
let pendingLog: Array<string> = []
let logWriting: Promise<unknown> = Promise.resolve()
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

// `/gc-cli [target] [--recipe=…] [--lenses=…] [--spec=…]` as `gauntlet
// review` argv. The target is `gauntlet review`'s: nothing is the working
// tree, a number a pull request, anything else `--commits` (`base..head`,
// or a base whose merge-base with HEAD starts the range). Other flags pass
// through as written (`--resume`, `--github-spec`, `--related-files`).
function reviewArgv(args: string): ReadonlyArray<string> {
  const words = args.match(/"[^"]*"|'[^']*'|\S+/g)?.map((word) => word.replace(/^(["'])(.*)\1$/, "$2")) ?? []
  const argv = ["review"]
  let target: string | undefined
  for (const word of words) {
    if (word.startsWith("--recipe=")) argv.push(word.slice("--recipe=".length))
    else if (word.startsWith("--")) argv.push(word)
    else target ??= word
  }
  if (argv.some((word) => word.startsWith("--resume"))) return argv
  if (target === undefined) argv.push("--working-tree")
  else if (/^\d+$/.test(target)) argv.push(`--pr=${target}`)
  else argv.push(`--commits=${target}`)
  return argv
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

function startTick($: Engines) {
  tick?.cancel()
  tick = $.clock.every(250, async () => {
    const running = engine?.running()
    if (running === undefined) return
    await engine?.poll()
    const agents = running.agentIds.join(",")
    if (agents !== markedAgents) {
      markedAgents = agents
      await markInFlight($, { ...running, cwd: runCwd })
    }
  })
}

async function finishRun($: Engines, result: RunResult, request: TriggerRequest) {
  tick?.cancel()
  tick = undefined
  await markInFlight($, undefined)
  await setStatus($, undefined)
  const digest = result.stdout.trim()
  const verdict = result.exitCode === 0 ? "finished" : "could not review"
  log($, `run ${verdict} exit ${String(result.exitCode)} after ${String(result.seconds)}s interrupted=${String(result.interrupted)}`)
  await $.fs.write(`${gcDir()}/last-run.json`, JSON.stringify({ ...result, request, stats: engine?.stats() }, null, 2))
  $.ui.toast(`gc-cli: review ${verdict} after ${String(result.seconds)}s`)
  const tail = result.stderr.trim().split("\n").filter((line) => line.includes("could not")).slice(-3).join("\n")
  const text = digest === "" ? `gc-cli: review ${verdict} (exit ${String(result.exitCode)}).\n${tail}` : `gc-cli review ${verdict}:\n\n${digest}`
  // The appended row reaches the model; the person sees transcript rows, one
  // per line (a row draws no line breaks).
  for (const line of (digest === "" ? text : digest).split("\n")) {
    if (line.trim() !== "") $.ui.log(line)
  }
  await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }).catch((error) =>
    log($, `append failed: ${String(error)}`)
  )
}

// Starts a review in the background; answers the command's one line.
async function startReview($: Engines, request: TriggerRequest): Promise<string> {
  if (engine === undefined || build === undefined) return "gc-cli: the engine did not load; see ~/.gauntlet/gc-cli/mod.log"
  const running = engine.running()
  if (running !== undefined) {
    return `gc-cli: a review is already running (${running.runId ?? "starting"}, ${String(Math.round((Date.now() - running.startedAt) / 1000))}s); one per session.`
  }
  const hashStart = Date.now()
  const fresh = await inputsStamp({ run: (argv, stdin) => $.process.run(argv, stdin === undefined ? {} : { stdin }) }, build.repoRoot)
    .catch((error) => ({ stamp: `unknown (${String(error)})`, files: 0 }))
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
      return `gc-cli: rebuilt the mod from the changed checkout in ${String(rebuildMs)}ms; it reloads in a few seconds. Run /gc-cli again.`
    }
  }
  const argv = reviewArgv(request.args)
  log($, `starting ${argv.join(" ")} in ${request.cwd}`)
  markedAgents = ""
  runCwd = request.cwd
  await markInFlight($, { startedAt: Date.now(), argv, cwd: request.cwd, agentIds: [], snapshots: [] })
  startTick($)
  void engine
    .start({ argv, cwd: request.cwd }, (line) => {
      log($, `cli: ${line}`)
      if (line.trim() !== "") void setStatus($, `gc-cli: ${line.replace(/^gauntlet: /, "").slice(0, 120)}`)
    })
    .then((result) => finishRun($, result, request))
    .catch((error) => log($, `run failed to start: ${String(error)}`))
  return `gc-cli: review started (${argv.slice(1).join(" ")}); progress on the status line, the digest lands here when it finishes.`
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
    await $.command.register({
      name: "gc-cli",
      description: "Gauntlet review, run in process: /gc-cli [target] [--recipe=…] [--lenses=…] [--spec=…]",
    })
    await reportLostRun($)
    $.clock.every(2000, () => checkTrigger($).catch((error) => log($, `trigger failed: ${String(error)}`)))
    return started
  })

  // The host labels the answer with the plugin's name already.
  on("command.run", { command: "gc-cli" }, async ($, e) => ({
    text: (await startReview($, { cwd: await $.session.root(), args: e.args })).replace(/^gc-cli: /, ""),
  }))

  // Every turn of every loop passes here; only this run's agents are taken.
  on("turn.complete", async ($, e, next) => {
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
