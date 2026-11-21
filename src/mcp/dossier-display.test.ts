import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import * as McpTest from "effect/ai/McpTest"
import { ContentDirectory } from "../content/lens.ts"
import { Candidate } from "../domain/candidate.ts"
import {
  Dossier,
  DossierFinding,
  DossierUnresolved,
  RefutedClaim,
} from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"
import {
  DISPLAY_PROTOCOLS,
  displayRegistrations,
  DOSSIER_APP_URI,
  MCP_APP_MIME_TYPE,
} from "./dossier-display.ts"

const FIXTURE_HTML = "<!doctype html><title>fixture app</title>"

const bugClaim = (id: string, summary: string) =>
  Candidate.cases.BugClaim.make({
    id,
    lens: "fixture-lens",
    file: "src/alpha.ts",
    line: 3,
    summary,
    failureScenario: "an empty input loops forever",
  })

const observation = (id: string, summary: string) =>
  Candidate.cases.Observation.make({ id, lens: "fixture-lens", file: "src/beta.ts", summary })

const dossier = Dossier.make({
  runId: "run-fixture",
  target: TargetIdentity.cases.PullRequest.make({
    repoRoot: "/repo",
    number: 7,
    baseCommit: "1111111aaaa",
    headCommit: "2222222bbbb",
  }),
  findings: [
    DossierFinding.cases.Confirmed.make({
      bugClaims: [bugClaim("fixture-lens/1", "loops\non empty input")],
      cluster: 1,
      verdict: Verdict.cases.Confirmed.make({ reviewPriority: "P1", evidence: "reproduced" }),
    }),
    DossierFinding.cases.Judgment.make({
      candidate: observation("fixture-lens/2", "naming drifts"),
      judgment: Judgment.cases.Kept.make({
        reviewPriority: "P3",
        reason: "real drift",
        goodFind: true,
        cleanlyExplained: true,
        mergedCandidateIds: [],
      }),
    }),
  ],
  unresolved: [
    DossierUnresolved.cases.Undecided.make({
      candidate: observation("fixture-lens/3", "unclear coupling"),
      judgment: Judgment.cases.Undecided.make({}),
    }),
  ],
  rejected: {
    refutedClaims: [RefutedClaim.make({
      bugClaims: [bugClaim("fixture-lens/4", "refuted claim")],
      cluster: 2,
      verdict: Verdict.cases.Refuted.make({ evidence: "guarded" }),
    })],
    droppedObservations: [],
  },
  coverageGaps: [{ stage: "finders", lens: "fixture-other", reason: "timed out" }],
})

// A Run directory holding the fixture dossier.json, and a content tree
// holding a fixture App page.
const setup = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-mcp-" })
  const runDir = path.join(root, "runs", "run-fixture")
  const content = path.join(root, "content")
  yield* fs.makeDirectory(runDir, { recursive: true })
  yield* fs.makeDirectory(path.join(content, "apps"), { recursive: true })
  const dossierJson = yield* Schema.encodeEffect(Schema.fromJsonString(Dossier))(dossier)
  yield* fs.writeFileString(path.join(runDir, "dossier.json"), dossierJson)
  yield* fs.writeFileString(path.join(content, "apps", "dossier.html"), FIXTURE_HTML)

  const client = yield* McpTest.makeClient(displayRegistrations, {
    protocols: DISPLAY_PROTOCOLS,
    protocolVersion: "2025-11-25",
  }).pipe(Effect.provideService(ContentDirectory, content))

  return { client, root, runDir }
})

describe("the display MCP server", () => {
  it.effect("lists show_dossier as a read-only tool that carries its App", () =>
    Effect.gen(function* () {
      const { client } = yield* setup
      const { tools } = yield* client.listTools()

      expect(tools).toHaveLength(1)
      expect(tools[0]?.name).toBe("show_dossier")
      expect(tools[0]?._meta).toEqual({ ui: { resourceUri: DOSSIER_APP_URI } })
      expect(tools[0]?.annotations?.readOnlyHint).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("serves the App page as an MCP App resource", () =>
    Effect.gen(function* () {
      const { client } = yield* setup
      const result = yield* client.readResource({ uri: DOSSIER_APP_URI })

      expect(result.contents).toEqual([
        { uri: DOSSIER_APP_URI, mimeType: MCP_APP_MIME_TYPE, text: FIXTURE_HTML },
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("shows a Run's Dossier as the digest's entries, one line each", () =>
    Effect.gen(function* () {
      const { client, runDir } = yield* setup
      const result = yield* client.callTool({ name: "show_dossier", arguments: { run_dir: runDir } })

      const expected = {
        runId: "run-fixture",
        target: "PR #7",
        tally: { confirmed: 1, kept: 1, plausible: 0, undecided: 1 },
        entries: [
          { tag: "confirmed", priority: "P1", location: "src/alpha.ts:3", summary: "loops on empty input" },
          { tag: "judgment", priority: "P3", location: "src/beta.ts", summary: "naming drifts" },
          { tag: "undecided", location: "src/beta.ts", summary: "unclear coupling" },
        ],
        coverageGaps: ["fixture-other (timed out)"],
        dossierMarkdown: `${runDir}/dossier.md`,
      }

      expect(result.isError).toBe(false)
      expect(result.structuredContent).toEqual(expected)
      // A client without the App reads the same digest as JSON text.
      const [text] = result.content
      expect(text?.type).toBe("text")

      const fromText = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(
        text?.type === "text" ? text.text : "",
      )

      expect(fromText).toEqual(expected)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("answers a directory without a Dossier with a tool error", () =>
    Effect.gen(function* () {
      const { client, root } = yield* setup
      const missing = `${root}/runs/no-such-run`
      const result = yield* client.callTool({ name: "show_dossier", arguments: { run_dir: missing } })

      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{
        type: "text",
        text: `no dossier.json at ${missing}/dossier.json: run_dir must be a finished Run's directory`,
      }])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
