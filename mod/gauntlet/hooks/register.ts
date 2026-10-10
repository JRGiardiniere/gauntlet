import type { EngineInterface, Register } from "claude-code"
import {
  BUILD_FILE,
  type BuildInfo,
  createEngine,
  createSession,
  type Engine,
  type EnginePorts,
  type Json,
  recoverLostRun,
  renderStrip,
  reviewToolArgs,
  reviewToolInputSchema,
  type Session,
} from "../../engine.ts"

// The gauntlet plugin (#134 Idea 3): the Gauntlet review program, bundled into this mod
// as hooks/vendor/engine.js and run in process. This module is the glue the
// engine cannot be: it is the only code that may spell `$`, so it hands the
// engine and the session policy (mod/session.ts) closures over `$` (ports),
// registers /gauntlet and the agent's review tool, turns hook events into
// calls on them, and draws the strip. A review's agents are `claude -p`
// children the engine starts through `$.process.spawn` (#181), so none of
// their tool calls or turns pass through these hooks.
//
// Every tool hook names its tool: matcher-less tool.call/tool.check hooks
// broke other subagents (#134). The turn.step hook only passes through; a
// worktree subagent's Bash still ran with it loaded (Claude Code 2.1.291,
// #146).

type Engines = EngineInterface

let engine: Engine | undefined
let session: Session | undefined
let home = ""
// When the review whose strip was dismissed started: dismissing clears the
// strip until the next review starts.
let dismissed: number | undefined
let drawn = ""
let drawnAt = 0
let pendingLog: Array<string> = []
let logWriting: Promise<unknown> = Promise.resolve()
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
    log: (line) => log($, line),
    store: {
      // SAFETY: the store takes JSON data only, and reads it back as set.
      get: async (key) => (await $.store.get(key)) as Json | undefined,
      set: (key, value) => $.store.set(key, value),
      delete: (key) => $.store.delete(key),
    },
    toast: (text, options) => $.ui.toast(text, options),
    status: (text) => $.ui.status(text),
    send: async (agentId, text) => {
      const sent = await $.session.send({ to: { agentId }, text })
      return sent.isDelivered ? undefined : sent.reason
    },
    // Bare, without Claude Code's "The gauntlet plugin sent a message" frame:
    // the prompt is a digest's one-line headline with the digest in the
    // appended row before it (the whole text only when that append failed),
    // and hooks still see the plugin as its origin.
    submit: async (text) => {
      const submitted = await $.prompt.submit({ text, asUser: true })
      return "drop" in submitted ? String(submitted.drop) : undefined
    },
    append: async (text) => {
      await $.session.append({ message: { type: "user", content: [{ type: "text", text }] } })
    },
  }
}

// The session's ticks, and the strip's: a running review redraws each half
// second for its clock and the agents' pulse, and any other change to what
// the strip shows (a review ending) redraws on the next tick.
function startClock($: Engines) {
  $.clock.every(250, async () => {
    const live = await (session?.tick() ?? Promise.resolve(false)).catch((error) => {
      log($, `tick failed: ${String(error)}`)
      return false
    })
    const view = engine?.view()
    if (view === undefined || view.startedAt === dismissed) return
    const shown = JSON.stringify({ ...view, startedAt: 0 })
    if (shown === drawn && (!live || Date.now() - drawnAt < 500)) return
    drawn = shown
    drawnAt = Date.now()
    $.ui.invalidate("ui.render")
  })
}

const reviewTool = (recipes: ReadonlyArray<string>) => ({
  name: "review",
  description: "Runs a Gauntlet code review in the background, here in Claude Code: finder agents, verification and judgment over a diff, ending in a Dossier and a short digest. " +
    "Use it when asked to run Gauntlet or a Gauntlet review; it replaces running the `gauntlet` CLI from a shell. " +
    "It returns at once. The digest arrives as a message when the review finishes (minutes, not seconds): between your tool calls while you work, or as a new turn once you stop, so carry on or end your turn. One review at a time per session. " +
    "`args` is the /gauntlet syntax, the same as the CLI's `gauntlet review`: a target, which is nothing for the uncommitted changes, a pull request number, or a commit range as git takes it (`main` for the commits since its merge-base, `abc123..def456`, `abc~1..abc` for one commit; add `--working-tree` to `main` to include uncommitted edits); " +
    "then `--repo <path>` to review another local checkout (absolute, `~/…`, or from the session's folder; a pull request number then names that repository's PR), `--recipe <name>` for the models and effort (left out, the configured default), `--lenses a,b`, `--spec <markdown file outside the repo>`, `--no-related-files`, `--destination pr` to also post the report as a comment on the pull request (only when the person asks). " +
    "`deliver <run-id>` posts a finished pull-request review's report on its pull request instead (only when the person asks). " +
    "`config` answers at once with the Mod's settings and recipes (~/.gauntlet/mod), each invalid recipe with why. " +
    (recipes.length === 0
      ? "No recipes are installed."
      : `Recipes: ${recipes.join(", ")}; when the person names an effort ("gauntlet high"), pass the recipe here that matches it.`),
  inputSchema: { ...reviewToolInputSchema },
})

async function openDossier($: Engines, path: string) {
  const opened = await $.process.run(["open", path]).catch((error) => ({ exitCode: 1, stderr: String(error) }))
  if (opened.exitCode !== 0) {
    log($, `open ${path} failed: ${opened.stderr.trim()}`)
    $.ui.toast(`gauntlet: could not open ${path}`)
  }
}

const UNLOADED = "the engine did not load; see ~/.gauntlet/mod/mod.log"

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
    const ports = portsOf($, env)
    const sessionId = await $.session.id()
    try {
      const loadStart = Date.now()
      // SAFETY: scripts/build-mod.ts writes build.json from a BuildInfo.
      const build = JSON.parse(await $.fs.read(`${$.plugin.root}/${BUILD_FILE}`)) as BuildInfo
      engine = createEngine(ports, build)
      session = createSession(ports, engine, { build, pluginRoot: $.plugin.root, sessionId })
      log($, `loaded engine ${build.stamp.slice(0, 12)} built ${build.builtAt} in ${String(Date.now() - loadStart)}ms (module loaded ${String(Date.now() - loadedAt)}ms ago)`)
    } catch (error) {
      log($, `engine failed to load: ${String(error)}`)
    }
    const recipes = await (engine?.recipes() ?? Promise.resolve([])).catch((error) => {
      log($, `recipe catalog unreadable: ${String(error)}`)
      return []
    })
    await $.tool.register(reviewTool(recipes))
    await $.command.register({
      name: "gauntlet",
      description: "Gauntlet review, run in process: /gauntlet [target] [--recipe <name>] [--lenses <a,b>] [--spec <file>] [--repo <path>] [--no-related-files] [--destination pr], /gauntlet deliver <run-id>, or /gauntlet config; --help for the rest",
    })
    await recoverLostRun(ports, sessionId)
    startClock($)
    return started
  })

  on("ui.render", { component: "AbovePrompt" }, ($, e, next) => {
    const view = engine?.view()
    if (view === undefined || view.startedAt === dismissed || e.props.hasSurvey) return next(e)
    return renderStrip(view, $.ui.resolve(e), { surface: e.surface, columns: e.props.bodyColumns }, Date.now(), {
      stop: () => {
        void engine?.cancel().then((cancelled) => log($, `stop pressed: ${String(cancelled)}`))
      },
      openDossier: (path) => {
        void openDossier($, path)
      },
      dismiss: () => {
        dismissed = view.startedAt
        $.ui.invalidate("ui.render")
      },
    })
  })

  // The host labels the answer with the plugin's name already.
  on("command.run", { command: "gauntlet" }, async ($, e) => ({
    text: (await session?.start({ cwd: await $.session.root(), args: e.args })) ?? UNLOADED,
  }))

  on("tool.call", { tool: "mcp__gauntlet__review" }, async ($, e) => {
    const args = reviewToolArgs(e)
    if (args === undefined) return { deny: "review takes `args`, a string: the target and flags as /gauntlet takes them." }
    const request = { cwd: await $.session.root(), args, agentId: e.agentId, isMainTurn: e.agentId === undefined }
    return { result: (await session?.start(request)) ?? UNLOADED }
  })

  // The main agent's turns (turn.start carries no agentId), so a digest knows
  // whether it would land in a running turn.
  on("turn.start", ($, e, next) => {
    session?.turnStarted()
    return next(e)
  })
  on("turn.step", async function* ($, e, next) {
    if (e.agentId === undefined) session?.stepped()
    return yield* next(e)
  })
  on("turn.complete", ($, e, next) => {
    if (e.agentId === undefined) void session?.turnEnded()
    return next(e)
  })
}
