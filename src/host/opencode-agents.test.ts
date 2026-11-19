import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { LLMClient, LLMEvent } from "@opencode/ai/effect"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { AbsolutePath, Agent, Integration, Model, Provider } from "@opencode/sdk/effect"
import * as Array from "effect/Array"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as References from "effect/References"
import { gunzipSync, gzipSync, zstdCompressSync, zstdDecompressSync } from "node:zlib"
import { emitToolSpec } from "../harness/invoke.ts"
import { EmitFindings } from "../harness/output-contract.ts"
import type { AgentSpec } from "../harness/harness-session.ts"
import { EmitPool } from "../stages/pool/output-contract.ts"
import { hostPaths } from "./host.ts"
import { rewriteCacheKey, withCacheKey } from "./opencode-agents.ts"
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

// A booted Host whose model requests go to a fake, and a Run snapshot.
const embedded = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-agents-home-" })
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-agents-snapshot-" })
  yield* fs.writeFileString(path.join(workspace, "alpha.txt"), "first line\n")
  const paths = yield* hostPaths().pipe(
    Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ HOME: home }))),
  )
  // No fallback: a request the test did not script fails the session.
  const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
  const host = yield* bootHost(paths, { _tag: "File", path: FIXTURE_CATALOG }, [
    llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
  ])
  yield* host.client.integration.connect.key({
    location: host.location,
    integrationID: Integration.ID.make("openai"),
    key: "sk-test",
  })
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

      expect(turn.end).toEqual({ _tag: "Emitted", raw: FINDINGS })
      const requests = yield* llm.requests()
      expect(requests).toHaveLength(2)
      // The usage is the session's own step totals, once each.
      expect(turn.usage).toEqual([
        { input: 1_200, output: 30, reasoning: 0, cacheRead: 0, cacheWrite: 0 },
        { input: 200, output: 40, reasoning: 0, cacheRead: 1_200, cacheWrite: 0 },
      ])
      expect(turn.toolCalls).toEqual({ total: 1, errored: 0 })
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
      expect(second.end).toEqual({ _tag: "Emitted", raw: FINDINGS })
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
      expect(pooled.end).toEqual({ _tag: "Emitted", raw: { clusters: [] } })

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
