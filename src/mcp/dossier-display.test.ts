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
  DroppedObservation,
  RefutedClaim,
} from "../domain/dossier.ts"
import { Judgment } from "../domain/judgment.ts"
import { TargetIdentity } from "../domain/review-target.ts"
import { Verdict } from "../domain/verdict.ts"
import { FinderStageArtifact } from "../run/finder-execution.ts"
import {
  DISPLAY_PROTOCOLS,
  displayRegistrations,
  DOSSIER_APP_URI,
  MCP_APP_MIME_TYPE,
} from "./dossier-display.ts"

const FIXTURE_HTML = "<!doctype html><title>fixture app</title>"

const bugClaim = (id: string, lens: string, summary: string) =>
  Candidate.cases.BugClaim.make({
    id,
    lens,
    file: "src/alpha.ts",
    line: 3,
    summary,
    failureScenario: "an empty input loops forever",
  })

const observation = (id: string, lens: string, summary: string) =>
  Candidate.cases.Observation.make({ id, lens, file: "src/beta.ts", summary })

// Two Lenses raised the confirmed claim; each other item has one.
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
      bugClaims: [
        bugClaim("fixture-lens/1", "fixture-lens", "loops\non empty input"),
        bugClaim("fixture-other/1", "fixture-other", "loops"),
      ],
      cluster: 1,
      verdict: Verdict.cases.Confirmed.make({ reviewPriority: "P1", evidence: "reproduced" }),
    }),
    DossierFinding.cases.Judgment.make({
      candidate: observation("fixture-lens/2", "fixture-lens", "naming drifts"),
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
      candidate: observation("fixture-lens/3", "fixture-lens", "unclear coupling"),
      judgment: Judgment.cases.Undecided.make({}),
    }),
  ],
  rejected: {
    refutedClaims: [RefutedClaim.make({
      bugClaims: [bugClaim("fixture-lens/4", "fixture-lens", "refuted claim")],
      cluster: 2,
      verdict: Verdict.cases.Refuted.make({ evidence: "guarded two lines above" }),
    })],
    droppedObservations: [DroppedObservation.make({
      candidate: observation("fixture-other/2", "fixture-other", "dropped observation"),
      judgment: Judgment.cases.Dropped.make({ reason: "style preference only" }),
    })],
  },
  coverageGaps: [{ stage: "finders", lens: "fixture-gap", reason: "timed out" }],
})

const finderEntry = (lens: string, findings: number) => ({
  invocationKey: `finder-${lens}`,
  outcome: {
    termination: { _tag: "Completed" as const },
    output: {
      findings: Array.from({ length: findings }, (_, index) => ({
        file: "src/alpha.ts",
        summary: `finding ${String(index + 1)}`,
      })),
    },
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, rawRows: [] },
    toolCalls: { total: 0, errored: 0 },
    durationMillis: 0,
    diagnostics: [],
  },
})

// fixture-quiet ran and emitted nothing.
const finderStage = {
  runId: "run-fixture",
  finders: [finderEntry("fixture-lens", 4), finderEntry("fixture-other", 2), finderEntry("fixture-quiet", 0)],
}

// A Run directory holding the fixture dossier.json (and finder-stage.json
// unless asked not to), and a content tree holding a fixture App page.
const setup = (options: { readonly finderStage: boolean }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-mcp-" })
    const runDir = path.join(root, "runs", "run-fixture")
    const content = path.join(root, "content")
    yield* fs.makeDirectory(runDir, { recursive: true })
    yield* fs.makeDirectory(path.join(content, "apps"), { recursive: true })

    const dossierJson = yield* Schema.encodeEffect(Schema.fromJsonString(Dossier))(dossier)
    yield* fs.writeFileString(path.join(runDir, "dossier.json"), dossierJson)

    if (options.finderStage) {
      const finderStageJson = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(FinderStageArtifact))(finderStage)
      yield* fs.writeFileString(path.join(runDir, "finder-stage.json"), finderStageJson)
    }

    yield* fs.writeFileString(path.join(content, "apps", "dossier.html"), FIXTURE_HTML)

    const client = yield* McpTest.makeClient(displayRegistrations, {
      protocols: DISPLAY_PROTOCOLS,
      protocolVersion: "2025-11-25",
    }).pipe(Effect.provideService(ContentDirectory, content))

    return { client, root, runDir }
  })

const textOf = (content: ReadonlyArray<{ readonly type: string; readonly text?: string }>) =>
  Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(content[0]?.text ?? "")

describe("the display MCP server", () => {
  it.effect("lists show_dossier as a read-only tool that carries its App", () =>
    Effect.gen(function* () {
      const { client } = yield* setup({ finderStage: true })
      const { tools } = yield* client.listTools()

      expect(tools).toHaveLength(1)
      expect(tools[0]?.name).toBe("show_dossier")
      expect(tools[0]?._meta).toEqual({ ui: { resourceUri: DOSSIER_APP_URI } })
      expect(tools[0]?.annotations?.readOnlyHint).toBe(true)
      expect(tools[0]?.inputSchema.required).toEqual(["run_dir"])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("serves the App page as an MCP App resource", () =>
    Effect.gen(function* () {
      const { client } = yield* setup({ finderStage: true })
      const result = yield* client.readResource({ uri: DOSSIER_APP_URI })

      expect(result.contents).toEqual([
        { uri: DOSSIER_APP_URI, mimeType: MCP_APP_MIME_TYPE, text: FIXTURE_HTML },
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("tells the model the digest, one line per entry", () =>
    Effect.gen(function* () {
      const { client, runDir } = yield* setup({ finderStage: true })
      const result = yield* client.callTool({ name: "show_dossier", arguments: { run_dir: runDir } })

      const text = yield* textOf(result.content)

      expect(result.isError).toBe(false)
      expect(text).toEqual({
        runId: "run-fixture",
        target: "PR #7",
        tally: { confirmed: 1, kept: 1, plausible: 0, undecided: 1 },
        entries: [
          { tag: "confirmed", priority: "P1", location: "src/alpha.ts:3", summary: "loops on empty input" },
          { tag: "judgment", priority: "P3", location: "src/beta.ts", summary: "naming drifts" },
          { tag: "undecided", location: "src/beta.ts", summary: "unclear coupling" },
        ],
        coverageGaps: ["fixture-gap (timed out)"],
        dossierMarkdown: `${runDir}/dossier.md`,
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("gives the App every item with its Lenses, the rejected ones and the Finders that ran", () =>
    Effect.gen(function* () {
      const { client, runDir } = yield* setup({ finderStage: true })
      const result = yield* client.callTool({ name: "show_dossier", arguments: { run_dir: runDir } })

      expect(result.structuredContent).toEqual({
        runId: "run-fixture",
        target: "PR #7",
        tally: { confirmed: 1, kept: 1, plausible: 0, undecided: 1, refuted: 1, dropped: 1 },
        candidates: 6,
        lenses: ["fixture-lens", "fixture-other", "fixture-quiet"],
        items: [
          {
            kind: "BugClaim",
            status: "confirmed",
            priority: "P1",
            lenses: ["fixture-lens", "fixture-other"],
            summary: "loops\non empty input",
            location: "src/alpha.ts:3",
          },
          {
            kind: "Observation",
            status: "kept",
            priority: "P3",
            lenses: ["fixture-lens"],
            summary: "naming drifts",
            location: "src/beta.ts",
          },
          {
            kind: "Observation",
            status: "undecided",
            lenses: ["fixture-lens"],
            summary: "unclear coupling",
            location: "src/beta.ts",
          },
          {
            kind: "BugClaim",
            status: "refuted",
            lenses: ["fixture-lens"],
            summary: "refuted claim",
            location: "src/alpha.ts:3",
            reason: "guarded two lines above",
          },
          {
            kind: "Observation",
            status: "dropped",
            lenses: ["fixture-other"],
            summary: "dropped observation",
            location: "src/beta.ts",
            reason: "style preference only",
          },
        ],
        coverageGaps: ["fixture-gap (timed out)"],
        dossierMarkdown: `${runDir}/dossier.md`,
      })
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("leaves the Finders and the candidate count out when finder-stage.json is missing", () =>
    Effect.gen(function* () {
      const { client, runDir } = yield* setup({ finderStage: false })
      const result = yield* client.callTool({ name: "show_dossier", arguments: { run_dir: runDir } })

      expect(result.isError).toBe(false)
      expect(result.structuredContent).not.toHaveProperty("lenses")
      expect(result.structuredContent).not.toHaveProperty("candidates")
      expect(result.structuredContent).toHaveProperty("items")
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("answers a directory without a Dossier with a tool error", () =>
    Effect.gen(function* () {
      const { client, root } = yield* setup({ finderStage: true })
      const missing = `${root}/runs/no-such-run`
      const result = yield* client.callTool({ name: "show_dossier", arguments: { run_dir: missing } })

      expect(result.isError).toBe(true)
      expect(result.content).toEqual([{
        type: "text",
        text: `no dossier.json at ${missing}/dossier.json: run_dir must be a finished Run's directory`,
      }])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
