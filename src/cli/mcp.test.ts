import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"
import { Dossier } from "../domain/dossier.ts"
import { TargetIdentity } from "../domain/review-target.ts"

const ENTRY = `${import.meta.dirname}/../../bin/gauntlet.ts`

const JsonRpcMessage = Schema.Struct({
  jsonrpc: Schema.Literal("2.0"),
  id: Schema.optionalKey(Schema.Union([Schema.Int, Schema.String, Schema.Null])),
  result: Schema.optionalKey(Schema.Unknown),
  error: Schema.optionalKey(Schema.Unknown),
})

const decodeLine = Schema.decodeUnknownEffect(Schema.fromJsonString(JsonRpcMessage))

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))

describe("gauntlet mcp", () => {
  it.live("speaks only JSON-RPC on stdout and exits cleanly when stdin closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-mcp-home-" })
      const runDir = path.join(home, "run-fixture")
      yield* fs.makeDirectory(runDir)

      const dossierJson = yield* Schema.encodeEffect(Schema.fromJsonString(Dossier))(
        Dossier.make({
          runId: "run-fixture",
          target: TargetIdentity.cases.PullRequest.make({
            repoRoot: "/repo",
            number: 7,
            baseCommit: "1111111aaaa",
            headCommit: "2222222bbbb",
          }),
          findings: [],
          unresolved: [],
          rejected: { refutedClaims: [], droppedObservations: [] },
          coverageGaps: [],
        }),
      )

      yield* fs.writeFileString(path.join(runDir, "dossier.json"), dossierJson)

      const requests = [
        {
          id: 1,
          method: "initialize",
          params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "fixture", version: "0" } },
        },
        { method: "notifications/initialized" },
        { id: 2, method: "tools/list" },
        { id: 3, method: "resources/read", params: { uri: "ui://gauntlet/dossier.html" } },
        { id: 4, method: "tools/call", params: { name: "show_dossier", arguments: { run_dir: runDir } } },
      ]

      const lines = yield* Effect.forEach(requests, (request) =>
        encodeJson({ jsonrpc: "2.0", ...request }))

      const input = `${Array.join(lines, "\n")}\n`

      const handle = yield* ChildProcess.make(process.execPath, [ENTRY, "mcp"], {
        cwd: home,
        extendEnv: true,
        env: { HOME: home },
        stdin: Stream.make(new TextEncoder().encode(input)),
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
      const messages = yield* Effect.forEach(stdout.trimEnd().split("\n"), (line) => decodeLine(line))
      const ids = Array.map(messages, (message) => message.id)
      expect(ids).toHaveLength(4)
      expect(ids).toEqual(expect.arrayContaining([1, 2, 3, 4]))
      expect(Array.filter(messages, (message) => message.error !== undefined)).toEqual([])
      expect(stdout).toContain(String.raw`"mimeType":"text/html;profile=mcp-app","text":"<!doctype html>`)
      expect(stdout).toContain(String.raw`\"runId\":\"run-fixture\"`)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)), 30_000)
})
