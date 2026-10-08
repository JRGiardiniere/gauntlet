import type { EngineInterface, Register } from "claude-code"
import {
  type BuildInfo,
  createEngine,
  digestDelivery,
  type Engine,
  type EnginePorts,
  inputsStamp,
  releaseNotice,
  renderStrip,
  commandWords,
  type ReviewRequest,
  reviewToolArgs,
  reviewToolInputSchema,
  type RunResult,
} from "../../engine.ts"

// The gauntlet plugin (#134 Idea 3): the Gauntlet review program, bundled into this mod
// as hooks/vendor/engine.js and run in process. This module is the glue the
// engine cannot be: it is the only code that may spell `$`, so it hands the
// engine closures over `$` (ports), registers /gauntlet and the agent's review
// tool, hands each digest to the main agent, relays turn endings
// and gauntlet-tools' observations, keeps the bundle fresh, and makes a
// reload that loses a run loud.
//
// Every tool and agent hook names its tool or agent: matcher-less
// tool.call/tool.check/agent.offer hooks broke other subagents (#134). The
// turn.step hook only passes through; a worktree subagent's Bash still ran
// with it loaded (Claude Code 2.1.291, #146).

type Engines = EngineInterface

const BUILD_FILE = "hooks/vendor/build.json"

// The store outlives a mod update, so its fields keep their names: `argv` is
// the words the review was started with, and `snapshots` the directories the
// run's snapshot was made in, each removed whole when the run is lost.
interface InFlight {
  readonly startedAt: number
  readonly argv: ReadonlyArray<string>
  readonly cwd: string
  readonly runId?: string | undefined
  readonly agentIds: ReadonlyArray<string>
  readonly snapshots: ReadonlyArray<string>
}

// What /gauntlet or the review tool asked to start.
interface StartRequest {
  readonly cwd: string
  readonly args: string
  // The subagent whose review tool call started the run; absent for the main
  // agent and /gauntlet.
  readonly agentId?: string | undefined
}

const agentsRef = { plugin: "gauntlet", key: "agents" } as const
const eventsRef = { plugin: "gauntlet-tools", key: "events" } as const

let engine: Engine | undefined
let build: BuildInfo | undefined
let home = ""
let tick: { readonly cancel: () => void } | undefined
let markedRun = ""
let runCwd = ""
// This session's in-flight marker: the store is one file for every session on
// the machine, and another session's live run is not lost.
let inflightKey = "inflight"
// Dismiss clears the strip until the next review starts.
let dismissed = false
let drawn = ""
let drawnAt = 0
let pendingLog: Array<string> = []
let logWriting: Promise<unknown> = Promise.resolve()
const delivery = digestDelivery()
const STORE_UPDATE_CHECK = "update-checked-at"
const DAY_MS = 86_400_000
// When this session's one review was claimed. The claim is taken before
// anything is awaited and given back once the review's ending has cancelled
// its ticker and cleared its marker: a second review is refused until then,
// and an ending never touches a newer review's ticker or marker.
let claimedAt: number | undefined
const loadedAt = Date.now()

const modDir = () => `${home}/.gauntlet/mod`

// Appends in batches: every session running the mod, and every reload of
// it, shares the one log, so none may rewrite it.
function log($: Engines, line: string) {
  pendingLog.push(`${new Date().toISOString()} [+${((Date.now() - loadedAt) / 1000).toFixed(1)}s] ${line}`)
  logWriting = logWriting.then(async () => {
    if (pendingLog.length === 0 || home === "") return
    const text = `${pendingLog.join("\n")}\n`
    pendingLog = []
    await $.process.run(["sh", "-c", 'mkdir -p "${1%/*}" && cat >> "$1"', "sh", `${modDir()}/mod.log`], { stdin: text })
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

// The in-flight marker outlives this module: a reload (or a crashed
// session) that loses the run leaves it behind for the next load to report.
async function markInFlight($: Engines, marker: InFlight | undefined) {
  if (marker === undefined) await $.store.delete(inflightKey)
  else await $.store.set(inflightKey, marker)
}

async function reportLostRun($: Engines) {
  // SAFETY: only markInFlight writes this key, always an InFlight.
  const lost = (await $.store.get(inflightKey)) as InFlight | undefined
  if (lost === undefined) return
  await markInFlight($, undefined)
  const stopped: Array<string> = []
  for (const agentId of lost.agentIds) {
    const result = await $.tool.call({ tool: "TaskStop", task_id: agentId }).catch((error) => ({ deny: String(error) }))
    stopped.push(`${agentId}: ${"deny" in result && result.deny !== undefined ? `not stopped (${result.deny})` : "stopped"}`)
  }
  // The lost run's snapshots: its finalizers never ran. Once a snapshot's
  // directory is gone, a prune drops git's record of the worktree in it.
  for (const snapshot of lost.snapshots) {
    const removed = await $.process.run(["rm", "-rf", snapshot]).catch((error) => ({ exitCode: 1, stderr: String(error) }))
    stopped.push(`${snapshot}: ${removed.exitCode === 0 ? "removed" : `not removed (${removed.stderr.trim()})`}`)
  }
  if (lost.snapshots.length > 0) await $.process.run(["git", "-C", lost.cwd, "worktree", "prune"]).catch(() => undefined)
  const age = Math.round((Date.now() - lost.startedAt) / 1000)
  const what = lost.runId === undefined ? `the review started ${String(age)}s ago` : `run ${lost.runId}`
  const note = `gauntlet: ${what} (${lost.argv.join(" ")}) was lost when the mod reloaded. ` +
    `${String(lost.agentIds.length)} orphaned agent(s) told to stop, ${String(lost.snapshots.length)} snapshot worktree(s) removed. ` +
    "Run /gauntlet again."
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
  const ticker = $.clock.every(250, async () => {
    const running = engine?.running()
    if (running === undefined) return
    await engine?.poll().catch((error) => log($, `poll failed: ${String(error)}`))
    // Cancelling stops the next tick, not this one: a run that ended during
    // the poll has had its marker cleared.
    if (tick !== ticker) return
    redraw($)
    const work = JSON.stringify([running.agentIds, running.snapshots])
    if (work !== markedRun) {
      markedRun = work
      await markInFlight($, { ...running, cwd: runCwd }).catch((error) => log($, `in-flight marker failed: ${String(error)}`))
    }
  })
  tick = ticker
}

async function finishRun($: Engines, result: RunResult, request: StartRequest, notice: Promise<string | undefined>) {
  tick?.cancel()
  tick = undefined
  await markInFlight($, undefined).catch((error) => log($, `in-flight marker failed: ${String(error)}`))
  claimedAt = undefined
  drawnAt = 0
  redraw($)
  const { digest, verdict } = result
  log($, `run ${verdict} after ${String(result.seconds)}s`)
  $.ui.toast(`gauntlet: ${verdict} after ${String(result.seconds)}s`)
  // The update probe gets a second more, as the CLI's notice does; a slow one
  // never holds back a finished review.
  const update = await Promise.race([notice, new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 1000))])
  const said = [...result.notes, ...(update === undefined ? [] : [update])]
  // Without a digest, the notes say what happened; the verdict stands in
  // only when there are none (a cancelled run).
  const shown = digest !== "" ? [...digest.split("\n"), ...said] : result.notes.length === 0 ? [verdict, ...said] : said
  const text = digest === ""
    ? `gauntlet: ${shown.join("\n")}`
    : `gauntlet ${verdict}:\n\n${digest}${said.length === 0 ? "" : `\n\n${said.join("\n")}`}`
  await deliver($, text, shown, request.agentId)
}

// A subagent that started the review gets its digest as a message, which
// reaches it between tool calls or resumes it once it has stopped; when it
// cannot be reached, the main agent gets it. A submitted prompt shows the
// person its text; an appended row or a subagent's message is the model's
// alone, so the person gets transcript rows, one per line (a row draws no
// line breaks).
async function deliver($: Engines, text: string, shown: ReadonlyArray<string>, agentId: string | undefined) {
  if (agentId !== undefined) {
    const sent = await $.session.send({ to: { agentId }, text }).catch((error) => ({ isDelivered: false as const, reason: String(error) }))
    if (sent.isDelivered) {
      logRows($, shown)
      return
    }
    log($, `digest not sent to ${agentId}: ${sent.reason}`)
  }
  if (delivery.route(text) === "submit" && (await submit($, text))) return
  logRows($, shown)
  await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } }).catch((error) =>
    log($, `append failed: ${String(error)}`)
  )
}

function logRows($: Engines, shown: ReadonlyArray<string>) {
  for (const line of shown) {
    if (line.trim() !== "") $.ui.log(line)
  }
}

// Whether the prompt entered; a dropped one leaves the digest to the rows and
// an appended message.
async function submit($: Engines, text: string): Promise<boolean> {
  const submitted = await $.prompt.submit({ text }).catch((error) => ({ drop: String(error) }))
  if (!("drop" in submitted)) return true
  log($, `submit dropped: ${String(submitted.drop)}`)
  return false
}

const reviewTool = (recipes: ReadonlyArray<string>) => ({
  name: "review",
  description: "Runs a Gauntlet code review in the background, here in Claude Code: finder agents, verification and judgment over a diff, ending in a Dossier and a short digest. " +
    "Use it when asked to run Gauntlet or a Gauntlet review; it replaces running the `gauntlet` CLI from a shell. " +
    "It returns at once. The digest arrives as a message when the review finishes (minutes, not seconds): between your tool calls while you work, or as a new turn once you stop, so carry on or end your turn. One review at a time per session. " +
    "`args` is the /gauntlet syntax, the same as the CLI's `gauntlet review`: a target, which is nothing for the uncommitted changes, a pull request number, or a commit range as git takes it (`main` for the commits since its merge-base, `abc123..def456`, `abc~1..abc` for one commit; add `--working-tree` to `main` to include uncommitted edits); " +
    "then `--repo <path>` to review another local checkout (absolute, `~/…`, or from the session's folder; a pull request number then names that repository's PR), `--recipe <name>` for the models and effort (left out, the configured default), `--lenses a,b`, `--spec <markdown file outside the repo>`, `--no-related-files`, `--destination pr` to also post the report as a comment on the pull request (only when the person asks). " +
    "`deliver <run-id>` posts a finished pull-request review's report on its pull request instead (only when the person asks). " +
    (recipes.length === 0
      ? "No Claude Code recipes are installed."
      : `Installed Claude Code recipes: ${recipes.join(", ")}; when the person names an effort or model ("gauntlet medium"), pass the recipe here that matches it.`),
  inputSchema: { ...reviewToolInputSchema },
})

async function openDossier($: Engines, path: string) {
  const opened = await $.process.run(["open", path]).catch((error) => ({ exitCode: 1, stderr: String(error) }))
  if (opened.exitCode !== 0) {
    log($, `open ${path} failed: ${opened.stderr.trim()}`)
    $.ui.toast(`gauntlet: could not open ${path}`)
  }
}

// Starts a review or a delivery in the background; answers the command's one
// line.
async function startReview($: Engines, request: StartRequest): Promise<string> {
  if (engine === undefined || build === undefined) return "the engine did not load; see ~/.gauntlet/mod/mod.log"
  if (claimedAt !== undefined) {
    return `a review is already running (${engine.running()?.runId ?? "starting"}, ${String(Math.round((Date.now() - claimedAt) / 1000))}s); one per session.`
  }
  claimedAt = Date.now()
  const unready = await checkFreshness($, build).catch((error) => {
    log($, `freshness check failed: ${String(error)}`)
    return `could not check the checkout for changes to the mod: ${String(error).slice(0, 300)}`
  })
  if (unready !== undefined) {
    claimedAt = undefined
    return unready
  }
  return startRun($, engine, build, request)
}

// Rebuilds the mod when the checkout changed since it was built; answers why
// the review cannot start now, when it cannot.
async function checkFreshness($: Engines, build: BuildInfo): Promise<string | undefined> {
  const hashStart = Date.now()
  const fresh = await inputsStamp({ run: (argv, stdin) => $.process.run(argv, stdin === undefined ? {} : { stdin }) }, build.repoRoot)
  const hashMs = Date.now() - hashStart
  // The stamp on disk, not the one loaded: a rebuild whose code came out
  // byte-identical (a docs or build-script change) rewrites only build.json,
  // and the engine reloads a plugin only when its modules change.
  // SAFETY: scripts/build-mod.ts writes build.json from a BuildInfo.
  const onDisk = JSON.parse(await $.fs.read(`${$.plugin.root}/${BUILD_FILE}`)) as BuildInfo
  log($, `stamp ${fresh.stamp} over ${String(fresh.files)} files in ${String(hashMs)}ms (built ${onDisk.stamp}, loaded ${build.stamp})`)
  if (fresh.stamp === onDisk.stamp) return undefined
  const rebuildStart = Date.now()
  $.ui.status("gauntlet: the checkout changed; rebuilding the mod")
  const built = await $.process.run([build.bun, "run", "build-mod", $.plugin.root.replace(/\/[^/]+$/, "")], {
    cwd: build.repoRoot,
    timeoutMs: 300_000,
  }).catch((error) => ({ exitCode: 1, stdout: "", stderr: String(error) }))
  const rebuildMs = Date.now() - rebuildStart
  log($, `rebuild exit ${String(built.exitCode)} in ${String(rebuildMs)}ms: ${built.stdout.trim()} ${built.stderr.trim()}`)
  $.ui.status(undefined)
  if (built.exitCode !== 0) return `the checkout changed and the rebuild failed: ${built.stderr.trim().slice(0, 300)}`
  return `rebuilt the mod from the changed checkout in ${String(rebuildMs)}ms; it reloads in a few seconds. Start the review again.`
}

async function startRun($: Engines, engine: Engine, build: BuildInfo, request: StartRequest): Promise<string> {
  const words = commandWords(request.args)
  log($, `starting ${words.join(" ")} in ${request.cwd}`)
  const run = engine.start({ words, cwd: request.cwd }, (line) => log($, `cli: ${line}`))
  if (words[0] === "deliver") {
    void run.ended.then((result) => finishRun($, result, request, Promise.resolve(undefined)))
      .catch((error) => log($, `delivery failed to finish: ${String(error)}`))
    return `delivering ${words.slice(1).join(" ")}; the outcome arrives as a message.`
  }
  markedRun = ""
  const notice = checkForUpdate($, build.repoRoot).catch((error) => {
    log($, `update check failed: ${String(error)}`)
    return undefined
  })
  // The review runs where its words say (`--repo`), and its marker is down
  // before its ending clears it; a failed marker write only logs.
  const marked = run.request.then(async (review) => {
    if (review === undefined) return
    // A review brings back a dismissed strip; help leaves it dismissed.
    dismissed = false
    runCwd = review.directory
    await markInFlight($, { startedAt: Date.now(), argv: words, cwd: review.directory, agentIds: [], snapshots: [] })
      .catch((error) => log($, `in-flight marker failed: ${String(error)}`))
    startTick($)
  })
  void run.ended.then(async (result) => {
    await marked
    await finishRun($, result, request, notice)
  }).catch((error) => log($, `run failed to finish: ${String(error)}`))
  const review = await run.request
  if (review === undefined) return "the review did not start; why arrives as a message."
  return `review started (${words.slice(1).join(" ")}${review.directory === request.cwd ? "" : ` in ${review.directory}`}); progress shows above the prompt, and the digest arrives as a message when it finishes.` +
    (await standardsNote($, engine, review))
}

// A repository with no Standards Manifest, on a review that would run the
// standards lens, gets the offer the gauntlet-code-review skill describes.
async function standardsNote($: Engines, engine: Engine, review: ReviewRequest): Promise<string> {
  if (review.selectedLensNames !== undefined && !review.selectedLensNames.includes("standards")) return ""
  const manifest = await engine.standardsManifest(review.directory).catch((error) => {
    log($, `standards manifest check failed: ${String(error)}`)
    return undefined
  })
  return manifest === undefined || manifest.exists
    ? ""
    : ` This repository has no Standards Manifest, so the standards lens is skipped this time; it goes at ${manifest.path}. Offer to set it up, as the gauntlet-code-review skill says.`
}

// At most one probe a day, as the CLI's: a newer release tag on origin rides on
// the digest of the review that probed.
async function checkForUpdate($: Engines, repoRoot: string): Promise<string | undefined> {
  const checkedAt = Number((await $.store.get(STORE_UPDATE_CHECK)) ?? 0)
  if (Date.now() - checkedAt < DAY_MS) return undefined
  await $.store.set(STORE_UPDATE_CHECK, Date.now())
  const [current, remote] = await Promise.all([
    $.process.run(["git", "-C", repoRoot, "describe", "--tags", "--exact-match", "--match", "v[0-9]*"]),
    $.process.run(["git", "-C", repoRoot, "ls-remote", "--tags", "--refs", "origin", "v[0-9]*"], { timeoutMs: 15_000 }),
  ])
  if (current.exitCode !== 0 || remote.exitCode !== 0) return undefined
  return releaseNotice(current.stdout, remote.stdout)
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
    const recipes = await (engine?.claudeRecipes() ?? Promise.resolve([])).catch((error) => {
      log($, `recipe catalog unreadable: ${String(error)}`)
      return []
    })
    await $.tool.register(reviewTool(recipes))
    await $.command.register({
      name: "gauntlet",
      description: "Gauntlet review, run in process: /gauntlet [target] [--recipe <name>] [--lenses <a,b>] [--spec <file>] [--repo <path>] [--no-related-files] [--destination pr], or /gauntlet deliver <run-id>; --help for the rest",
    })
    inflightKey = `inflight:${await $.session.id()}`
    await reportLostRun($)
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
  on("command.run", { command: "gauntlet" }, async ($, e) => ({
    text: await startReview($, { cwd: await $.session.root(), args: e.args }),
  }))

  on("tool.call", { tool: "mcp__gauntlet__review" }, async ($, e) => {
    const args = reviewToolArgs(e)
    if (args === undefined) return { deny: "review takes `args`, a string: the target and flags as /gauntlet takes them." }
    return { result: await startReview($, { cwd: await $.session.root(), args, agentId: e.agentId }) }
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
      if (unread !== undefined) void submit($, unread).then((entered) => entered ? undefined : log($, "unread digest left in the conversation"))
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
  on("tool.check", { tool: "SendMessage" }, ($, e, next) => (next.origin?.plugin === "gauntlet" ? { decision: "allow" } : next(e)))
  on("tool.check", { tool: "TaskStop" }, ($, e, next) => (next.origin?.plugin === "gauntlet" ? { decision: "allow" } : next(e)))

  // Hidden from the model except while the engine's SendMessage resumes one.
  on("agent.offer", { agent: "gauntlet:slot-1" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gauntlet:slot-2" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gauntlet:slot-3" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gauntlet:slot-4" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gauntlet:slot-5" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gauntlet:slot-6" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gauntlet:slot-7" }, () => ({ isOffered: engine?.isOffering() === true }))
  on("agent.offer", { agent: "gauntlet:slot-8" }, () => ({ isOffered: engine?.isOffering() === true }))
}
