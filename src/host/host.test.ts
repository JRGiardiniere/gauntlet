import { describe, expect, it } from "@effect/vitest"
import { DatabaseSync } from "node:sqlite"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { Global } from "@opencode/util/global"
import { OpenCode } from "@opencode/sdk/effect"
import * as Array from "effect/Array"
import * as Clock from "effect/Clock"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Schedule from "effect/Schedule"
import * as Scope from "effect/Scope"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"
import { CLAUDE_SESSION_VARIABLES, scrubHostEnvironment } from "./host-environment.ts"
import { hostPaths, type HostPaths, ModelCatalog } from "./host.ts"
import { bootHost } from "./opencode-host.ts"

// The embedded OpenCode Host booted for real, offline: a fixture catalog file
// stands in for OpenCode's models.dev fetch, and every home is a temp dir.

const FIXTURE_CATALOG = `${import.meta.dirname}/fixtures/models.json`

const BOOT_SCRIPT = `${import.meta.dirname}/fixtures/boot-host.ts`

const TRACE_PRELOAD = `${import.meta.dirname}/fixtures/trace-opencode.mjs`

const GAUNTLET = `${import.meta.dirname}/../../bin/gauntlet.ts`

const SLOW = 60_000

const Booted = Schema.fromJsonString(Schema.Struct({
  models: Schema.Array(Schema.String),
  openai: Schema.Array(Schema.String),
  skills: Schema.Array(Schema.Struct({ name: Schema.String })),
  config: Schema.Array(Schema.Struct({ path: Schema.optionalKey(Schema.String) })),
}))

// The person's own OpenCode and Claude setup, each piece carrying a canary.
const writeCanaryHome = Effect.fn("test.writeCanaryHome")(function* (home: string) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const write = (file: string, text: string) =>
    fs.makeDirectory(path.dirname(path.join(home, file)), { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(path.join(home, file), text)),
    )

  const skill = (name: string) => `---\nname: ${name}\ndescription: canary ${name}\n---\nCANARY\n`
  yield* write(
    ".config/opencode/opencode.json",
    '{"provider":{"openai":{"models":{"canary-global-config":{"name":"Canary"}}}}}\n',
  )
  yield* write(".config/opencode/AGENTS.md", "CANARY global instructions\n")
  yield* write(".config/opencode/skills/canary-global/SKILL.md", skill("canary-global"))
  yield* write(".agents/skills/canary-agents/SKILL.md", skill("canary-agents"))
  yield* write(".claude/skills/canary-claude/SKILL.md", skill("canary-claude"))
  yield* write(".claude/CLAUDE.md", "CANARY claude instructions\n")
  // OpenCode's legacy login file, which a fresh OpenCode store imports.
  yield* write(".local/share/opencode/auth.json", '{"openai":{"type":"api","key":"sk-canary-legacy"}}\n')
})

// Every file under `root`, relative, skipping `skip`.
const listTree = Effect.fn("test.listTree")(function* (root: string, skip: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* fs.readDirectory(root, { recursive: true })

  return Array.sort(
    Array.filter(entries, (entry) => !Array.some(skip, (prefix) => entry.startsWith(prefix))),
    (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0),
  )
})

// Runs the boot script with `home` as the process's home directory and no
// XDG overrides, so OpenCode's defaults would land in the canary home.
const bootIn = Effect.fn("test.bootIn")(function* (home: string, mode: "gauntlet" | "control") {
  const handle = yield* ChildProcess.make(process.execPath, [BOOT_SCRIPT, mode, FIXTURE_CATALOG], {
    cwd: home,
    extendEnv: true,
    env: {
      HOME: home,
      XDG_CONFIG_HOME: undefined,
      XDG_DATA_HOME: undefined,
      XDG_STATE_HOME: undefined,
      XDG_CACHE_HOME: undefined,
      OPENCODE_FLAGS: undefined,
      // OpenCode honours this key with no login; it makes OpenAI's models listable.
      OPENAI_API_KEY: "sk-test-env",
      // No real `claude` is ever probed.
      OPENCODE_CLAUDE_PATH: "/nonexistent/claude",
    },
  })

  const [stdout, stderr, exitCode] = yield* Effect.all(
    [
      Stream.decodeText(handle.stdout).pipe(Stream.mkString),
      Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      handle.exitCode,
    ],
    { concurrency: 3 },
  )

  expect(stderr).toBe("")
  expect(exitCode).toBe(0)

  return yield* Schema.decodeEffect(Booted)(stdout)
}, Effect.scoped)

describe("the Host's isolation", () => {
  it.live("loads none of the person's OpenCode or Claude setup, and lists the catalog", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-host-home-" })
      yield* writeCanaryHome(home)
      const before = yield* listTree(home, [".gauntlet", ".bun"])

      const booted = yield* bootIn(home, "gauntlet")

      expect(booted.skills).toEqual([])
      expect(Array.flatMap(booted.config, (entry) => (entry.path === undefined ? [] : [entry.path]))).toEqual([])
      expect(booted.models).not.toContain("openai/canary-global-config")
      // Connected through the environment only: the legacy auth.json was not imported.
      expect(booted.openai).toEqual(["env"])
      expect(booted.models).toEqual(expect.arrayContaining([
        "openai/gpt-6.2-sol",
        "openai/gpt-6.1-terra",
        "openai/gpt-6.1-terra-fast",
        "openai/gpt-6-luna",
      ]))
      // Everything the Host wrote is under ~/.gauntlet.
      const observed1 = yield* listTree(home, [".gauntlet", ".bun"])
      expect(observed1).toEqual(before)
      const observed2 = yield* fs.exists(`${home}/.gauntlet/opencode/gauntlet.db`)
      expect(observed2).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  it.live("is needed: OpenCode's defaults load that same setup", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-host-control-" })
      yield* writeCanaryHome(home)

      const booted = yield* bootIn(home, "control")

      expect(Array.map(booted.skills, (skill) => skill.name)).toEqual(
        expect.arrayContaining(["canary-global", "canary-agents", "canary-claude"]),
      )
      expect(booted.models).toContain("openai/canary-global-config")
      expect(booted.openai).toContain("credential")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)
})

describe("scrubHostEnvironment", () => {
  it.effect("removes the Claude Code session variables and OPENCODE_FLAGS, keeping logins", () =>
    Effect.gen(function* () {
      const environment: Parameters<typeof scrubHostEnvironment>[0] = {
        CLAUDE_CONFIG_DIR: "/config",
        CLAUDE_CODE_OAUTH_TOKEN: "token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        OPENCODE_FLAGS: "all",
        PATH: "/bin",
      }

      for (const name of CLAUDE_SESSION_VARIABLES) environment[name] = "session"
      yield* scrubHostEnvironment(environment)
      expect(environment).toEqual({
        CLAUDE_CONFIG_DIR: "/config",
        CLAUDE_CODE_OAUTH_TOKEN: "token",
        CLAUDE_CODE_USE_BEDROCK: "1",
        PATH: "/bin",
      })
    }))
})

// A claim is a timestamp on the session row with no owner; a turn holds it
// while it runs. Writing it directly stands in for another process's live turn.
const claim = (paths: HostPaths, sessionID: string) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    const database = new DatabaseSync(paths.database)
    database.prepare("update session_v2 set time_suspended = ? where id = ?").run(now, sessionID)
    database.close()
  })

const sessionState = (paths: HostPaths, sessionID: string) =>
  Effect.sync(() => {
    const database = new DatabaseSync(paths.database)
    const row = database.prepare("select time_suspended is not null as claimed from session_v2 where id = ?").get(sessionID)

    const notices = database
      .prepare("select count(*) as count from session_message where session_id = ? and data like ?")
      .get(sessionID, '%"notice":"restart"%')

    database.close()

    return { claimed: row?.["claimed"] === 1, restartNotices: Number(notices?.["count"]) }
  })

const resumeHome = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-host-resume-" })

  return yield* hostPaths().pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
  )
})

// Each Host in its own scope, closed with the test's if not closed sooner.
const bootScoped = (paths: HostPaths) =>
  Effect.gen(function* () {
    const testScope = yield* Effect.scope
    const scope = yield* Scope.fork(testScope)
    const host = yield* bootHost(paths, ModelCatalog.File({ path: FIXTURE_CATALOG })).pipe(Scope.provide(scope))

    return { host, close: Scope.close(scope, Exit.void) }
  })

// How long the no-resume test watches; the control below shows OpenCode's
// own resume landing well inside it.
const RESUME_WINDOW = "2 seconds"

describe("the Host on a shared store", () => {
  it.live("never resumes a session another Host has claimed", () =>
    Effect.gen(function* () {
      const paths = yield* resumeHome
      const first = yield* bootScoped(paths)
      const session = yield* first.host.client.sessions.create({ location: first.host.location, title: "live run" })
      yield* claim(paths, session.id)

      const second = yield* bootScoped(paths)
      yield* Effect.sleep(RESUME_WINDOW)
      const observed3 = yield* sessionState(paths, session.id)
      expect(observed3).toEqual({ claimed: true, restartNotices: 0 })
      yield* second.close
      yield* first.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  it.live("is needed: OpenCode's default resumes it within that window", () =>
    Effect.gen(function* () {
      const paths = yield* resumeHome
      const path = yield* Path.Path
      const first = yield* bootScoped(paths)
      const session = yield* first.host.client.sessions.create({ location: first.host.location, title: "live run" })
      yield* claim(paths, session.id)

      // OpenCode's own resume, kept off the real home's OpenCode paths.
      const root = path.join(paths.root, "control")
      yield* OpenCode.create(
        {
          database: { path: paths.database },
          config: { directory: path.join(root, "config"), project: false, claude: false },
          models: { file: FIXTURE_CATALOG, fetch: false, snapshot: false },
          fs: { filewatcher: false, fff: false },
        },
        {
          overrides: [
            Global.node.replace(Global.layerWith({
              home: paths.home,
              data: path.join(root, "data"),
              state: path.join(root, "state"),
              cache: path.join(root, "cache"),
              config: path.join(root, "config"),
              log: path.join(root, "log"),
              bin: path.join(root, "bin"),
              repos: path.join(root, "repos"),
              tmp: path.join(root, "tmp"),
            })),
          ],
        },
      )

      const resumed = yield* sessionState(paths, session.id).pipe(
        Effect.repeat({ schedule: Schedule.spaced("50 millis"), until: (state) => state.restartNotices > 0 }),
        Effect.timeout(RESUME_WINDOW),
      )

      expect(resumed.restartNotices).toBe(1)
      yield* first.close
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)
})

// The production entry point under a preload that reports `@opencode/*`
// imports: commands that never use the Host never load OpenCode at all.
const traceImports = Effect.fn("test.traceImports")(function* (args: ReadonlyArray<string>) {
  const fs = yield* FileSystem.FileSystem
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-host-startup-" })

  const handle = yield* ChildProcess.make(process.execPath, ["--preload", TRACE_PRELOAD, ...args], {
    cwd: home,
    extendEnv: true,
    env: { HOME: home },
    // At end of input from the start, so `mcp` serves nothing and exits.
    stdin: "ignore",
  })

  const [, stderr, exitCode] = yield* Effect.all(
    [
      Stream.decodeText(handle.stdout).pipe(Stream.mkString),
      Stream.decodeText(handle.stderr).pipe(Stream.mkString),
      handle.exitCode,
    ],
    { concurrency: 3 },
  )

  return { imports: Array.filter(stderr.split("\n"), (line) => line.startsWith("opencode-import")), exitCode }
}, Effect.scoped)

describe("startup", () => {
  it.live.each([
    { argv: ["--help"] },
    { argv: ["--version"] },
    { argv: ["config"] },
    { argv: ["config", "init"] },
    { argv: ["mcp"] },
  ])("gauntlet $argv never loads OpenCode", ({ argv }) =>
    Effect.gen(function* () {
      const traced = yield* traceImports([GAUNTLET, ...argv])
      expect(traced).toEqual({ imports: [], exitCode: 0 })
    }).pipe(Effect.provide(NodeServices.layer)), SLOW)

  it.live("is observed: the preload reports an OpenCode import", () =>
    Effect.gen(function* () {
      const traced = yield* traceImports(["-e", 'await import("@opencode/sdk/effect")'])
      expect(traced.imports).not.toEqual([])
    }).pipe(Effect.provide(NodeServices.layer)), SLOW)
})
