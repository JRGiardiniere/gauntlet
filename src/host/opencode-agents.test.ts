import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { LLMClient, LLMEvent } from "@opencode/ai/effect"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { AbsolutePath, Agent, Integration, Model, Provider, Session } from "@opencode/sdk/effect"
import * as Array from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { toEntries as recordEntries } from "effect/Record"
import * as References from "effect/References"
import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { emitToolSpec } from "../harness/invoke.ts"
import { EmitFindings } from "../harness/output-contract.ts"
import { type AgentSpec, TurnEnd } from "../harness/harness-session.ts"
import { EmitPool } from "../stages/pool/output-contract.ts"
import { hostPaths, ModelCatalog } from "./host.ts"
import { Permission } from "@opencode/core/permission"
import * as Schema from "effect/Schema"
import { exposeInstalledDependencies } from "../run/installed-dependencies.ts"
import { acquireReviewWorkingDirectory } from "../run/review-working-directory.ts"
import { resolveCommitsTarget } from "../target/commits.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import {
  ALLOWED_FILE,
  ALLOWED_TEXT,
  CANARY,
  makeAgentConfigRepo,
  markersWritten,
  toJson,
} from "../test-support/agent-config-repo.fixture.ts"
import { permissionsFor, rewriteCacheKey, withCacheKey } from "./opencode-agents.ts"
import { bootHost } from "./opencode-host.ts"

// The embedded Host, offline: OpenCode's fake language model answers every
// model request, so a test sees exactly which requests a session sent.

const FIXTURE_CATALOG = `${import.meta.dirname}/fixtures/models.json`

const SLOW = 60_000

const SEAT = "openai/gpt-6-luna:low"

const FINDINGS = { findings: [{ file: "alpha.txt", line: 1, summary: "the first line is wrong" }] }

const usage = (input: number, cacheRead: number, output: number) => ({
  inputTokens: input + cacheRead,
  nonCachedInputTokens: input,
  cacheReadInputTokens: cacheRead,
  outputTokens: output,
})

const emitCall = (id: string, name: string, input: typeof FINDINGS | { readonly clusters: ReadonlyArray<never> }, tokens = usage(1_000, 0, 50)) =>
  TestLLM.complete({ reason: { normalized: "tool-calls" }, usage: tokens }, LLMEvent.toolCall({ id, name, input }))

const textStop = (text: string, tokens = usage(900, 100, 20)) =>
  TestLLM.complete(
    { reason: { normalized: "stop" }, usage: tokens },
    LLMEvent.textStart({ id: "t" }),
    LLMEvent.textDelta({ id: "t", text }),
    LLMEvent.textEnd({ id: "t" }),
  )

// A booted Host whose model requests go to a fake.
const bootEmbedded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-agents-home-" })

  const paths = yield* hostPaths().pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
  )

  // No fallback: a request the test did not script fails the session.
  const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))

  const host = yield* bootHost(paths, ModelCatalog.File({ path: FIXTURE_CATALOG }), [
    llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
  ])

  yield* host.client.integration.connect.key({
    location: host.location,
    integrationID: Integration.ID.make("openai"),
    key: "sk-test",
  })

  return { host, llm }
})

// A Run snapshot and Finder specs for it.
const embedded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-agents-snapshot-" })
  yield* fs.writeFileString(path.join(workspace, "alpha.txt"), "first line\n")
  const { host, llm } = yield* bootEmbedded

  const finder = (): AgentSpec => ({
    invocationId: "fixture-finder",
    role: "finder-1",
    seat: SEAT,
    workspace: path.resolve(workspace),
    systemPrompt: "fixture finder system prompt",
    tools: ["read", "grep", "glob"],
    emit: emitToolSpec(EmitFindings),
  })

  const finderIn = (cacheGroup?: string): AgentSpec =>
    cacheGroup === undefined ? finder() : { ...finder(), cacheGroup }

  return { host, llm, finder: finderIn }
})

const toolNames = (request: { readonly tools: ReadonlyArray<{ readonly name: string }> }) =>
  Array.sort(Array.map(request.tools, (tool) => tool.name), (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0))

describe("an AgentInvocation session on the embedded Host", () => {
  it.live("ends the turn at a valid emit with no further model request, counting each request once", () =>
    Effect.gen(function* () {
      const { host, llm, finder } = yield* embedded
      yield* llm.push(
        // A read, then the emit in the next step.
        TestLLM.complete(
          { reason: { normalized: "tool-calls" }, usage: usage(1_200, 0, 30) },
          LLMEvent.toolCall({ id: "read-1", name: "read", input: { path: "alpha.txt" } }),
        ),
        emitCall("emit-1", "emit_findings", FINDINGS, usage(200, 1_200, 40)),
      )
      const session = yield* host.openSession(finder())
      const turn = yield* session.turn("review alpha.txt")

      expect(turn.end).toEqual(TurnEnd.Emitted({ raw: FINDINGS }))
      const requests = yield* llm.requests()
      expect(requests).toHaveLength(2)
      // The usage is the session's own step totals, once each.
      expect(turn.usage).toEqual([
        { input: 1_200, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        { input: 200, output: 40, reasoning: 0, cacheRead: 1_200, cacheWrite: 0 },
      ])
      expect(turn.toolCalls).toEqual({ total: 1, errored: 0, erroredPaths: [] })
      yield* session.firstToken
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  it.live("ends a turn without an emit as Stopped, and takes the corrective turn on the same session", () =>
    Effect.gen(function* () {
      const { host, llm, finder } = yield* embedded
      yield* llm.push(textStop("I found one issue."), emitCall("emit-1", "emit_findings", FINDINGS))
      const session = yield* host.openSession(finder())

      const first = yield* session.turn("review alpha.txt")
      expect(first.end._tag).toBe("Stopped")
      expect(first.usage).toHaveLength(1)
      const second = yield* session.turn("You ended without calling emit_findings.")
      expect(second.end).toEqual(TurnEnd.Emitted({ raw: FINDINGS }))
      expect(second.usage).toHaveLength(1)
      const requests = yield* llm.requests()
      expect(requests).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  it.live("logs the session transcript only at debug level", () =>
    Effect.gen(function* () {
      const { host, llm, finder } = yield* embedded
      yield* llm.push(emitCall("emit-1", "emit_findings", FINDINGS), emitCall("emit-2", "emit_findings", FINDINGS))
      const logged: Array<unknown> = []

      const collector = Logger.layer([Logger.make(({ message }) => {
        logged.push(message)
      })])

      const quiet = yield* host.openSession(finder())
      yield* quiet.turn("review quietly").pipe(Effect.provide(collector))
      expect(logged).toEqual([])

      const session = yield* host.openSession(finder())
      yield* session.turn("review alpha.txt").pipe(
        Effect.provide(collector),
        Effect.provideService(References.MinimumLogLevel, "Debug"),
      )
      expect(logged).toContainEqual([
        "agent transcript",
        { invocationId: "fixture-finder", entryIndex: 1, entry: { role: "user", text: "review alpha.txt" } },
      ])
      expect(logged).toContainEqual([
        "agent transcript",
        expect.objectContaining({ entryIndex: 2, entry: expect.objectContaining({ type: "assistant" }) }),
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  it.live("offers a Finder read, grep, glob and its emit tool, and Pool its emit tool only", () =>
    Effect.gen(function* () {
      const { host, llm, finder } = yield* embedded
      yield* llm.push(
        emitCall("emit-1", "emit_findings", FINDINGS),
        emitCall("emit-2", "emit_pool", { clusters: [] }),
      )
      const finderSession = yield* host.openSession(finder())
      yield* finderSession.turn("review")

      const pool = yield* host.openSession({
        ...finder(),
        invocationId: "fixture-pool",
        role: "pool",
        systemPrompt: "fixture stage system prompt",
        tools: [],
        emit: emitToolSpec(EmitPool),
      })

      const pooled = yield* pool.turn("cluster")
      expect(pooled.end).toEqual(TurnEnd.Emitted({ raw: { clusters: [] } }))

      const [finderRequest, poolRequest] = yield* llm.requests()
      expect(finderRequest === undefined ? [] : toolNames(finderRequest)).toEqual(["emit_findings", "glob", "grep", "read"])
      expect(poolRequest === undefined ? [] : toolNames(poolRequest)).toEqual(["emit_pool"])
      // OpenAI gets the agent's own system prompt and nothing after it.
      expect(Array.map(finderRequest?.system ?? [], (part) => part.text)).toEqual(["fixture finder system prompt"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  it.live("sends every session of a cache group the group's key", () =>
    Effect.gen(function* () {
      const { host, llm, finder } = yield* embedded
      yield* llm.push(
        emitCall("emit-1", "emit_findings", FINDINGS),
        emitCall("emit-2", "emit_findings", FINDINGS),
        emitCall("emit-3", "emit_findings", FINDINGS),
      )

      for (const group of ["run-finders-1", "run-finders-1", undefined]) {
        const session = yield* host.openSession(finder(group))
        yield* session.turn("review")
      }

      const requests = yield* llm.requests()
      const headers = Array.map(requests, (request) => request.headers ?? {})
      expect(Array.map(headers, (sent) => sent["session-id"] ?? sent["x-session-affinity"])).toEqual([
        "run-finders-1",
        "run-finders-1",
        expect.stringMatching(/^ses_/),
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  // Why the key is set per request rather than by making the Finders child
  // sessions of one anchor, which OpenCode would key alike.
  it.live("is needed: a finished child session wakes its never-prompted parent for a model request", () =>
    Effect.gen(function* () {
      const { host, llm, finder } = yield* embedded
      yield* llm.push(textStop("child answer"), textStop("the parent woke"))
      const location = { directory: AbsolutePath.make(finder().workspace) }
      const model = Model.Ref.make({ providerID: Provider.ID.make("openai"), id: Model.ID.make("gpt-6-luna"), variant: Model.VariantID.make("low") })
      const parent = yield* host.client.sessions.create({ location, title: "anchor", model, agent: Agent.ID.make("build") })
      const child = yield* host.client.sessions.create({ parentID: parent.id, title: "finder", model, agent: Agent.ID.make("build") })

      yield* host.client.sessions.prompt({ sessionID: child.id, text: "review" })
      yield* host.client.experimental.session.wait({ sessionID: child.id })
      yield* llm.wait(2)
      yield* host.client.experimental.session.wait({ sessionID: parent.id })

      const requests = yield* llm.requests()
      expect(requests).toHaveLength(2)
      const parentMessages = yield* host.client.message.list({ sessionID: parent.id })
      expect(Array.map(parentMessages.data, (message) => message.type)).toEqual(expect.arrayContaining(["synthetic", "assistant"]))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)
})

describe("the partition cache key on an outgoing request", () => {
  const body = `{"model":"gpt-6-luna","prompt_cache_key":"ses_own","input":[]}`
  const keyed = `{"model":"gpt-6-luna","prompt_cache_key":"run-finders-1","input":[]}`

  it("replaces the key in a body or frame that carries one, and leaves others alone", () => {
    expect(rewriteCacheKey(body, "run-finders-1")).toEqual(Option.some(keyed))
    expect(rewriteCacheKey(`{"type":"response.cancel"}`, "run-finders-1")).toEqual(Option.none())
    expect(rewriteCacheKey("not json", "run-finders-1")).toEqual(Option.none())
  })

  it.effect.each([
    { encoding: undefined, encode: (bytes: Uint8Array) => bytes, decode: (bytes: Uint8Array) => bytes },
    { encoding: "gzip", encode: gzipSync, decode: gunzipSync },
    { encoding: "zstd", encode: zstdCompressSync, decode: zstdDecompressSync },
  ])("rewrites a $encoding body in its own encoding", ({ encoding, encode, decode }) =>
    Effect.gen(function* () {
      const headers = new Headers({ "content-type": "application/json" })

      if (encoding !== undefined) headers.set("content-encoding", encoding)

      const request = new Request("https://chatgpt.example/backend-api/codex/responses", {
        method: "POST",
        headers,
        body: encode(new TextEncoder().encode(body)),
      })

      const rewritten = yield* withCacheKey(request, "run-finders-1")
      const sent = yield* Effect.tryPromise({ try: () => rewritten.arrayBuffer(), catch: String })
      expect(new TextDecoder().decode(decode(new Uint8Array(sent)))).toBe(keyed)
      expect(rewritten.headers.get("content-encoding")).toBe(encoding ?? null)
    }))
})

describe("the ReviewWorkspace permission rules", () => {
  const rules = [...permissionsFor({ tools: ["read", "grep", "glob"], emit: "emit_findings" })]
  const Segment = Schema.String.check(Schema.isPattern(/^[A-Za-z0-9._-]{1,12}$/))

  it.prop(
    "never fall through to asking, whatever the action or resource",
    { action: Schema.String, resource: Schema.String },
    ({ action, resource }) => {
      expect(Permission.evaluate(action, resource, rules).effect).not.toBe("ask")
    },
  )

  it.prop(
    "allow reading any path in the snapshot",
    { segments: Schema.NonEmptyArray(Segment) },
    ({ segments }) => {
      expect(Permission.evaluate("read", Array.join(segments, "/"), rules).effect).toBe("allow")
    },
  )

  it.each([
    ["grep", "anything", "allow"],
    ["glob", "**/*", "allow"],
    ["emit_findings", "*", "allow"],
    ["write", "src/x.ts", "deny"],
    ["edit", "src/x.ts", "deny"],
    ["shell", "touch x", "deny"],
    ["webfetch", "https://example.com", "deny"],
    ["external_directory", "/etc/*", "deny"],
  ])("%s %s → %s", (action, resource, effect) => {
    expect(Permission.evaluate(action, resource, rules).effect).toBe(effect)
  })

  it("give Pool its emit tool and nothing else", () => {
    const pool = [...permissionsFor({ tools: [], emit: "emit_pool" })]
    expect(Permission.evaluate("emit_pool", "*", pool).effect).toBe("allow")

    for (const action of ["read", "grep", "glob", "emit_findings"]) {
      expect(Permission.evaluate(action, "src/x.ts", pool).effect).toBe("deny")
    }
  })
})

type ToolOutcome = { readonly status: string; readonly text: string }

// Each tool call's ending in a session, by call id.
const toolOutcomes = (host: Effect.Success<typeof bootEmbedded>["host"], sessionID: string) =>
  host.client.message.list({ sessionID: Session.ID.make(sessionID) }).pipe(
    Effect.map((page) => {
      const outcomes = new Map<string, ToolOutcome>()

      for (const message of page.data) {
        if (message.type !== "assistant") continue

        for (const part of message.content) {
          if (part.type !== "tool") continue
          const state = part.state

          switch (state.status) {
            case "error":
              outcomes.set(part.id, { status: state.status, text: state.error.message })
              break
            case "completed":
              outcomes.set(part.id, {
                status: state.status,
                text: Array.join(Array.map(state.content, (item) => (item.type === "text" ? item.text : item.uri)), "\n"),
              })
              break
            case "running":
            case "streaming":
              outcomes.set(part.id, { status: state.status, text: "" })
          }
        }
      }

      return outcomes
    }),
  )

describe("a review of a repo carrying its own agent config", () => {
  it.live("serves reads inside the snapshot as written, offers no write or shell, and loads nothing from the repo", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path
      const { markers, repo, target } = yield* makeAgentConfigRepo
      const snapshot = yield* acquireReviewWorkingDirectory(target, "fence-test", "/nonexistent/overlay.patch")
      const afterSnapshot = yield* markersWritten(markers)
      expect(afterSnapshot).toEqual([])
      const { host, llm } = yield* bootEmbedded

      // [call id, tool, input, served].
      const calls: ReadonlyArray<readonly [string, string, Readonly<Record<string, string | boolean>>, boolean]> = [
        ["read-allowed", "read", { path: ALLOWED_FILE }, true],
        ["read-directory", "read", { path: "pkg" }, true],
        ["grep-walk", "grep", { pattern: "allowed" }, true],
        ["glob-walk", "glob", { pattern: "**/*", hidden: true }, true],
        ["write", "write", { path: "new.txt", content: "x" }, false],
        ["edit", "edit", { path: ALLOWED_FILE, oldString: "allowed", newString: "x" }, false],
        ["shell", "shell", { command: `touch ${markers}/shell` }, false],
        ["bash", "bash", { command: `touch ${markers}/bash` }, false],
        ["read-parent", "read", { path: path.relative(snapshot, path.join(repo, ALLOWED_FILE)) }, false],
        ["read-absolute", "read", { path: path.join(repo, ALLOWED_FILE) }, false],
        ["read-home", "read", { path: "~/.bashrc" }, false],
        ["grep-absolute", "grep", { pattern: "allowed", path: repo }, false],
        ["glob-absolute", "glob", { pattern: "*", path: repo }, false],
      ]

      yield* llm.push(
        TestLLM.complete(
          { reason: { normalized: "tool-calls" }, usage: usage(1_000, 0, 50) },
          ...Array.map(calls, ([id, name, input]) => LLMEvent.toolCall({ id, name, input })),
        ),
        emitCall("emit-1", "emit_findings", FINDINGS),
      )

      const session = yield* host.openSession({
        invocationId: "fence-finder",
        role: "finder-1",
        seat: SEAT,
        workspace: snapshot,
        systemPrompt: "fixture finder system prompt",
        tools: ["read", "grep", "glob"],
        emit: emitToolSpec(EmitFindings),
      })

      const turn = yield* session.turn("review")
      expect(turn.end).toEqual(TurnEnd.Emitted({ raw: FINDINGS }))

      const sessions = yield* host.client.sessions.list({ directory: AbsolutePath.make(snapshot) })
      const opened = Array.findFirst(sessions.data, (info) => info.title === "fence-finder")
      const outcomes = yield* toolOutcomes(host, Option.getOrThrow(opened).id)
      const served = Array.map(calls, ([id, name, , allowed]) => [id, name, outcomes.get(id)?.status === "completed", allowed])
      expect(served).toEqual(Array.map(calls, ([id, name, , allowed]) => [id, name, allowed, allowed]))
      expect(outcomes.get("read-allowed")?.text).toContain(ALLOWED_TEXT)
      expect(outcomes.get("grep-walk")?.text).toContain(ALLOWED_FILE)

      // Nothing the repo wrote reached a model: no config, plugin, MCP
      // server, skill or instructions (root, nested next to the allowed
      // read, or CLAUDE.md).
      const requests = yield* llm.requests()
      expect(requests).toHaveLength(2)
      const sent = toJson(requests)
      expect(sent).not.toContain(CANARY)
      expect(sent).not.toContain("BANANA")
      expect(Array.map(requests, toolNames)).toEqual([
        ["emit_findings", "glob", "grep", "read"],
        ["emit_findings", "glob", "grep", "read"],
      ])
      expect(Array.map(requests[0]?.system ?? [], (part) => part.text)).toEqual(["fixture finder system prompt"])
      const afterRun = yield* markersWritten(markers)
      expect(afterRun).toEqual([])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)
})

// A reviewed repo whose Caller installed dependencies and has other ignored
// files: build output, `.dev.vars`, and a workspace package linked from
// node_modules.
const makeInstalledRepo = (installed: boolean) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const { repo } = yield* makeGitFixture({ prefix: "gauntlet-agents-dependencies-" })

    const write = (files: Readonly<Record<string, string>>) =>
      Effect.forEach(recordEntries(files), ([file, text]) =>
        fs.makeDirectory(path.dirname(path.join(repo, file)), { recursive: true }).pipe(
          Effect.andThen(fs.writeFileString(path.join(repo, file), text)),
        ), { discard: true })

    yield* write({ ".gitignore": "/node_modules/\ndist/\n*.log\n.dev.vars\npackages/w/\n", "README.md": "base\n" })
    yield* commitAll(repo, "base")
    yield* write({ "package.json": "{}\n", "vendored/package.json": "{}\n", "vendored/node_modules/kept.js": "tracked\n" })
    yield* commitAll(repo, "head")

    yield* write({
      ".dev.vars": "TOKEN=x\n",
      "dist/build.js": "build output\n",
      "packages/w/w.ts": "export const workspace = 1\n",
      "vendored/node_modules/untracked.js": "installed over tracked content\n",
    })

    if (installed) {
      yield* write({
        "node_modules/fixture-pkg/dist/index.js": "HOOK_MARKER in dist\n",
        "node_modules/fixture-pkg/lib/x.js": "HOOK_MARKER in lib\n",
        "node_modules/fixture-pkg/debug.log": "HOOK_MARKER in a log\n",
        "node_modules/.bin/fixture-tool": "a package's executable\n",
      })
      yield* fs.symlink(path.join(repo, "packages/w"), path.join(repo, "node_modules/workspace-link"))
    }

    return yield* resolveCommitsTarget(repo, "HEAD~1..HEAD")
  })

const dependencyFinder = (snapshot: string): AgentSpec => ({
  invocationId: "dependency-finder",
  role: "finder-1",
  seat: SEAT,
  workspace: snapshot,
  systemPrompt: "fixture finder system prompt",
  tools: ["read", "grep", "glob"],
  emit: emitToolSpec(EmitFindings),
})

type ToolCall = readonly [string, string, Readonly<Record<string, string | boolean>>, boolean]

// Runs every call in one model step, then the emit; answers each call's
// outcome and the turn.
const runCalls = (snapshot: string, calls: ReadonlyArray<ToolCall>) =>
  Effect.gen(function* () {
    const { host, llm } = yield* bootEmbedded

    yield* llm.push(
      TestLLM.complete(
        { reason: { normalized: "tool-calls" }, usage: usage(1_000, 0, 50) },
        ...Array.map(calls, ([id, name, input]) => LLMEvent.toolCall({ id, name, input })),
      ),
      emitCall("emit-1", "emit_findings", FINDINGS),
    )

    const session = yield* host.openSession(dependencyFinder(snapshot))
    const turn = yield* session.turn("review")
    const sessions = yield* host.client.sessions.list({ directory: AbsolutePath.make(snapshot) })
    const opened = Array.findFirst(sessions.data, (info) => info.title === "dependency-finder")
    const outcomes = yield* toolOutcomes(host, Option.getOrThrow(opened).id)
    const served = Array.map(calls, ([id, name]) => [id, name, outcomes.get(id)?.status === "completed"])
    expect(served).toEqual(Array.map(calls, ([id, name, , allowed]) => [id, name, allowed]))

    return { outcomes, turn }
  })

describe("the read tools over the Caller's installed dependencies", () => {
  it.live("serve explicit dependency paths to read, grep and glob past the checkout's ignore rules, and nothing else ignored", () =>
    Effect.gen(function* () {
      const target = yield* makeInstalledRepo(true)
      const snapshot = yield* acquireReviewWorkingDirectory(target, "fence-dependencies", "/nonexistent/overlay.patch")
      yield* exposeInstalledDependencies(target, "fence-dependencies", snapshot)
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      // Ignored by the snapshot's own rules, which still apply outside dependencies.
      yield* fs.writeFileString(path.join(snapshot, "scratch.log"), "HOOK_MARKER ignored in the snapshot\n")

      const { outcomes, turn } = yield* runCalls(snapshot, [
        ["read-dependency", "read", { path: "node_modules/fixture-pkg/lib/x.js" }, true],
        ["read-dependency-directory", "read", { path: "node_modules/fixture-pkg" }, true],
        ["grep-dependency", "grep", { pattern: "HOOK_MARKER", path: "node_modules/fixture-pkg" }, true],
        ["grep-dependency-include", "grep", { pattern: "HOOK_MARKER", path: "node_modules/fixture-pkg", include: "*.js" }, true],
        ["glob-dependency", "glob", { pattern: "**/*.js", path: "node_modules/fixture-pkg" }, true],
        ["glob-dependency-hidden", "glob", { pattern: "**/*", path: "node_modules/fixture-pkg", hidden: true }, true],
        ["read-tracked-node-modules", "read", { path: "vendored/node_modules/kept.js" }, true],
        ["read-workspace-link", "read", { path: "node_modules/workspace-link/w.ts" }, true],
        ["read-dependency-bin", "read", { path: "node_modules/.bin/fixture-tool" }, true],
        ["grep-snapshot-ignored", "grep", { pattern: "HOOK_MARKER" }, true],
        ["read-dev-vars", "read", { path: ".dev.vars" }, false],
        ["read-build-output", "read", { path: "dist/build.js" }, false],
        ["read-untracked-over-tracked", "read", { path: "vendored/node_modules/untracked.js" }, false],
      ])

      const text = (id: string) => outcomes.get(id)?.text ?? ""
      expect(text("read-dependency")).toContain("HOOK_MARKER in lib")
      expect(text("grep-dependency")).toContain("node_modules/fixture-pkg/dist/index.js")
      expect(text("grep-dependency")).toContain("node_modules/fixture-pkg/debug.log")
      expect(text("grep-dependency-include")).toContain("node_modules/fixture-pkg/dist/index.js")
      expect(text("grep-dependency-include")).toContain("node_modules/fixture-pkg/lib/x.js")
      expect(text("grep-dependency-include")).not.toContain("debug.log")
      expect(text("glob-dependency")).toContain("node_modules/fixture-pkg/dist/index.js")
      expect(text("glob-dependency")).not.toContain("debug.log")
      expect(text("glob-dependency-hidden")).toContain("node_modules/fixture-pkg/debug.log")
      expect(text("read-workspace-link")).toContain("export const workspace = 1")
      expect(text("grep-snapshot-ignored")).toBe("No matches found")

      expect(turn.toolCalls.erroredPaths).toEqual([".dev.vars", "dist/build.js", "vendored/node_modules/untracked.js"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)

  it.live("answers a dependency path with why it is missing when nothing was installed", () =>
    Effect.gen(function* () {
      const target = yield* makeInstalledRepo(false)
      const snapshot = yield* acquireReviewWorkingDirectory(target, "fence-no-dependencies", "/nonexistent/overlay.patch")
      const installed = yield* exposeInstalledDependencies(target, "fence-no-dependencies", snapshot)
      expect(installed.exposed).toEqual([])

      const { outcomes } = yield* runCalls(snapshot, [
        ["read-missing", "read", { path: "node_modules/fixture-pkg/index.js" }, false],
        ["glob-missing", "glob", { pattern: "**/*.d.ts", path: "node_modules" }, false],
      ])

      expect(outcomes.get("read-missing")?.text).toBe(
        "Unavailable: dependencies were not installed in the caller's checkout, so node_modules/fixture-pkg/index.js is not available to this review.",
      )
      expect(outcomes.get("glob-missing")?.text).toContain("dependencies were not installed in the caller's checkout")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), SLOW)
})
