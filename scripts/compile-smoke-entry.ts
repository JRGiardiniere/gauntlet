// The compile smoke's entry, compiled by scripts/compile-smoke.ts exactly as
// the release binary is: it opens the embedded Host through the same lazy
// import, offline (a fixture catalog and OpenCode's fake language model), and
// runs one Verifier turn that executes read, grep, and shell in Code Mode and
// then emits.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import { LLMClient, LLMEvent } from "@opencode/ai/effect"
import { TestLLM } from "@opencode/ai/testing"
import { llmClient } from "@opencode/core/effect/app-node-platform"
import { Integration } from "@opencode/sdk/effect"
import * as Console from "effect/Console"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { TurnEnd, VERIFICATION_TOOLS } from "../src/harness/harness-session.ts"
import { emitToolSpec } from "../src/harness/invoke.ts"
import { EmitFindings } from "../src/harness/output-contract.ts"
import { hostPaths, ModelCatalog } from "../src/host/host.ts"

class SmokeFailed extends Schema.TaggedError<
  SmokeFailed,
  { readonly brand: unique symbol }
>()("SmokeFailed", {
  reason: Schema.String,
}) {}

const [catalog = ""] = process.argv.slice(2)

const NEEDLE = "compile-smoke needle"

const FINDINGS = { findings: [{ file: "alpha.txt", line: 2, summary: "the needle is here" }] }

const usage = { inputTokens: 1_000, nonCachedInputTokens: 1_000, cacheReadInputTokens: 0, outputTokens: 20 }

const toJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

const program = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const workspace = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-compile-smoke-" })
  yield* fs.writeFileString(path.join(workspace, "alpha.txt"), `first line\n${NEEDLE}\n`)

  const module = yield* Effect.tryPromise({
    try: () => import("../src/host/opencode-host.ts"),
    catch: (cause) => SmokeFailed.make({ reason: `the Host chunk did not load: ${String(cause)}` }),
  })

  const llm = yield* TestLLM.Test.pipe(Effect.provide(TestLLM.testLayer()))
  const paths = yield* hostPaths()

  const host = yield* module.bootHost(paths, ModelCatalog.File({ path: catalog }), [
    llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
  ])

  yield* host.client.integration.connect.key({
    location: host.location,
    integrationID: Integration.ID.make("openai"),
    key: "sk-compile-smoke",
  })

  yield* llm.push(
    TestLLM.complete(
      { reason: { normalized: "tool-calls" }, usage },
      LLMEvent.toolCall({
        id: "exec-1",
        name: "execute",
        input: {
          code: `const [file, hits, ran] = await Promise.all([
            tools.read({ path: "alpha.txt" }),
            tools.grep({ pattern: "${NEEDLE}" }),
            tools.shell({ command: "printf 'smoke_%s_verified' ok" }),
          ]);
          return { file, grepStatus: hits.length > 0 && hits[0]?.entry?.path === "alpha.txt" ? "GREP" + "_MATCHED" : "GREP_EMPTY", ran }`,
        },
      }),
    ),
    TestLLM.complete(
      { reason: { normalized: "tool-calls" }, usage },
      LLMEvent.toolCall({ id: "emit-1", name: "emit_findings", input: FINDINGS }),
    ),
  )

  const session = yield* host.openSession({
    invocationId: "compile-smoke",
    role: "verifier-1",
    seat: "openai/gpt-6-luna:low",
    workspace,
    systemPrompt: "compile smoke verifier",
    tools: VERIFICATION_TOOLS,
    emit: emitToolSpec(EmitFindings),
  })

  const turn = yield* session.turn("Find the needle.")

  if (!TurnEnd.$is("Emitted")(turn.end)) {
    return yield* SmokeFailed.make({ reason: `the turn ended ${turn.end._tag}, not at the emit` })
  }

  // The Code Mode result is in the request that follows it; both markers are
  // computed at runtime and never appear verbatim in the tool input.
  const [, afterExecute] = yield* llm.requests()
  const sent = yield* toJson(afterExecute ?? null)

  if (!sent.includes(NEEDLE) || !sent.includes("smoke_ok_verified") || !sent.includes("GREP_MATCHED")) {
    return yield* SmokeFailed.make({ reason: "execute did not return read, grep, and shell output" })
  }

  yield* Console.log(`compile smoke ok: Host opened, execute (read + grep + shell) ran, emit landed (${String(turn.usage.length)} requests)`)
})

NodeRuntime.runMain(program.pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
