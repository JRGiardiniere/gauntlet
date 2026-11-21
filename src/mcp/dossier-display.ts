// Display-only MCP front end (#202): reviews run through the CLI, and this
// server only shows a finished Run's Dossier as an MCP App
// (`io.modelcontextprotocol/ui`) inside the chat client.
import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpSchema from "effect/ai/McpSchema"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import { gauntletVersion } from "../cli/version.ts"
import { ContentDirectory } from "../content/lens.ts"
import { Dossier } from "../domain/dossier.ts"
import { ReviewPriority } from "../domain/verdict.ts"
import { describePlatformError } from "../run/artifact.ts"
import { FinderStageArtifact } from "../run/finder-execution.ts"
import { lensOfFinderInvocationKey } from "../run/finder-partitions.ts"
import { runPaths } from "../run/run-record.ts"
import {
  describeCoverageGap,
  entryLocation,
  entrySummary,
  tallyDossier,
} from "../render/digest.ts"
import {
  type DossierEntryTag,
  type DossierEntryView,
  viewDossier,
} from "../render/dossier-view.ts"
import { describeTargetShort } from "../render/target-text.ts"

export const DOSSIER_APP_URI = "ui://gauntlet/dossier.html"

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

// Findings and unresolved items only: refuted and dropped stay in dossier.md.
const DigestTag = Schema.Literals(["confirmed", "judgment", "plausible", "undecided"])

// The stdout digest's content as data, and the tool's text for the model: a
// line's worth per entry.
export const DossierDigest = Schema.Struct({
  runId: Schema.String,
  target: Schema.String,
  tally: Schema.Struct({
    confirmed: Schema.Int,
    kept: Schema.Int,
    plausible: Schema.Int,
    undecided: Schema.Int,
  }),
  entries: Schema.Array(Schema.Struct({
    tag: DigestTag,
    priority: Schema.optionalKey(ReviewPriority),
    location: Schema.String,
    summary: Schema.String,
  })),
  coverageGaps: Schema.Array(Schema.String),
  dossierMarkdown: Schema.String,
})

export type DossierDigest = typeof DossierDigest.Type

export const DisplayStatus = Schema.Literals([
  "confirmed",
  "kept",
  "plausible",
  "undecided",
  "refuted",
  "dropped",
])

export type DisplayStatus = typeof DisplayStatus.Type

// Every evaluated item of the Dossier, rejected ones included, credited to
// each Lens that raised it.
export const DisplayItem = Schema.Struct({
  kind: Schema.Literals(["BugClaim", "Observation"]),
  status: DisplayStatus,
  priority: Schema.optionalKey(ReviewPriority),
  lenses: Schema.Array(Schema.String),
  summary: Schema.String,
  location: Schema.String,
  // Why a refuted or dropped item was rejected.
  reason: Schema.optionalKey(Schema.String),
})

export type DisplayItem = typeof DisplayItem.Type

// The App's data: the tool's structured result. `lenses` and `candidates`
// come from finder-stage.json and are absent when it is missing or unreadable.
export const DossierDisplay = Schema.Struct({
  runId: Schema.String,
  target: Schema.String,
  tally: Schema.Struct({
    confirmed: Schema.Int,
    kept: Schema.Int,
    plausible: Schema.Int,
    undecided: Schema.Int,
    refuted: Schema.Int,
    dropped: Schema.Int,
  }),
  candidates: Schema.Int.pipe(Schema.optionalKey),
  lenses: Schema.String.pipe(Schema.Array, Schema.optionalKey),
  items: Schema.Array(DisplayItem),
  coverageGaps: Schema.Array(Schema.String),
  dossierMarkdown: Schema.String,
})

export type DossierDisplay = typeof DossierDisplay.Type

export class DossierUnavailable extends Schema.TaggedError<
  DossierUnavailable,
  { readonly brand: unique symbol }
>()("DossierUnavailable", {
  message: Schema.String,
}) {}

const digestEntries = (
  entries: ReadonlyArray<DossierEntryView>,
): DossierDigest["entries"] =>
  Array.flatMap(entries, (entry) => {
    if (!Schema.is(DigestTag)(entry.tag)) return []
    const core = { tag: entry.tag, location: entryLocation(entry), summary: entrySummary(entry) }

    return [entry.reviewPriority === undefined ? core : { ...core, priority: entry.reviewPriority }]
  })

export const digestDossier = (dossier: Dossier, dossierMarkdown: string): DossierDigest => {
  const view = viewDossier(dossier)

  return {
    runId: dossier.runId,
    target: describeTargetShort(dossier.target),
    tally: tallyDossier(view),
    entries: digestEntries([...view.findings, ...view.unresolved]),
    coverageGaps: Array.map(dossier.coverageGaps, describeCoverageGap),
    dossierMarkdown,
  }
}

const STATUS_OF_TAG = {
  confirmed: "confirmed",
  judgment: "kept",
  plausible: "plausible",
  undecided: "undecided",
  refuted: "refuted",
  dropped: "dropped",
} as const satisfies { readonly [Tag in DossierEntryTag]: DisplayStatus }

const displayItem = (entry: DossierEntryView): DisplayItem => {
  const status = STATUS_OF_TAG[entry.tag]

  const item: DisplayItem = {
    kind: entry.candidate._tag,
    status,
    lenses: entry.lenses,
    summary: entry.candidate.summary,
    location: entryLocation(entry),
  }

  const prioritized = entry.reviewPriority === undefined
    ? item
    : { ...item, priority: entry.reviewPriority }

  // Only a rejected item's detail is its reason; the rest stay in dossier.md.
  return (status === "refuted" || status === "dropped") && entry.detail !== undefined
    ? { ...prioritized, reason: entry.detail }
    : prioritized
}

export interface FinderStageSummary {
  readonly lenses: ReadonlyArray<string>
  readonly candidates: number
}

export const summarizeFinderStage = (stage: FinderStageArtifact): FinderStageSummary => ({
  lenses: Array.map(stage.finders, ({ invocationKey }) => lensOfFinderInvocationKey(invocationKey)),
  candidates: Array.reduce(
    stage.finders,
    0,
    (total, { outcome }) => total + (outcome.output?.findings.length ?? 0),
  ),
})

export const displayDossier = (
  dossier: Dossier,
  dossierMarkdown: string,
  finderStage: Option.Option<FinderStageSummary>,
): DossierDisplay => {
  const view = viewDossier(dossier)

  return {
    runId: dossier.runId,
    target: describeTargetShort(dossier.target),
    tally: {
      ...tallyDossier(view),
      refuted: view.refutedClaims.length,
      dropped: view.droppedObservations.length,
    },
    ...Option.match(finderStage, {
      onNone: () => ({}),
      onSome: ({ candidates, lenses }) => ({ candidates, lenses }),
    }),
    items: Array.map(
      [...view.findings, ...view.unresolved, ...view.refutedClaims, ...view.droppedObservations],
      displayItem,
    ),
    coverageGaps: Array.map(dossier.coverageGaps, describeCoverageGap),
    dossierMarkdown,
  }
}

export const ShowDossierParameters = Schema.Struct({
  run_dir: Schema.String.annotate({
    description: "Absolute path of the Run directory that holds dossier.json",
  }),
})

const SHOW_DOSSIER_DESCRIPTION =
  "Show a finished Gauntlet review's Dossier: the tally, each finding and unresolved item with its " +
  "Review Priority and location, and coverage gaps. `run_dir` is the absolute path of the Run " +
  "directory, the one holding dossier.json and dossier.md (the digest's last line names dossier.md in it)."

const unavailable = (message: string) => DossierUnavailable.make({ message })

const encodeDigestText = Schema.encodeEffect(Schema.fromJsonString(DossierDigest))

const encodeDisplay = Schema.encodeEffect(DossierDisplay)

// Registered on the server directly rather than through a Toolkit: a Toolkit
// sends the structured result as the model's text too, and the model's text
// stays the digest while the App gets the fuller display.
const showDossierTool = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const inputSchema = yield* Schema.decodeUnknownEffect(McpSchema.ToolJson)(
      ShowDossierParameters.pipe(Tool.getJsonSchemaFromSchema),
    ).pipe(Effect.orDie)

    const outputSchema = yield* Schema.decodeEffect(McpSchema.ToolOutputJson)(
      DossierDisplay.pipe(Tool.getJsonSchemaFromSchema),
    ).pipe(Effect.orDie)

    const readFinderStage = (file: string) =>
      fs.readFileString(file).pipe(
        Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(FinderStageArtifact))),
        Effect.map(summarizeFinderStage),
        // Optional enrichment: a Run without a readable one still displays.
        Effect.option,
      )

    const showDossier = Effect.fn("DossierDisplay.showDossier")(function* (runDirectory: string) {
      const runDir = path.resolve(runDirectory)
      const paths = runPaths(path.dirname(runDir), path.basename(runDir), path)

      const source = yield* fs.readFileString(paths.dossier).pipe(
        Effect.mapError((failure) =>
          unavailable(
            Predicate.isTagged("NotFound")(failure.reason)
              ? `no dossier.json at ${paths.dossier}: run_dir must be a finished Run's directory`
              : `could not read ${paths.dossier}: ${describePlatformError(failure)}`,
          )),
      )

      const dossier = yield* Schema.decodeEffect(Schema.fromJsonString(Dossier))(source).pipe(
        Effect.mapError((cause) =>
          unavailable(`${paths.dossier} is not a Dossier: ${cause.message.replace(/\s+/g, " ")}`)),
      )

      const finderStage = yield* readFinderStage(paths.finderStage)
      const text = yield* encodeDigestText(digestDossier(dossier, paths.dossierMarkdown)).pipe(Effect.orDie)

      const structuredContent = yield* encodeDisplay(
        displayDossier(dossier, paths.dossierMarkdown, finderStage),
      ).pipe(Effect.orDie)

      return McpSchema.CallToolResult.make({
        isError: false,
        content: [{ type: "text", text }],
        structuredContent,
      })
    })

    yield* server.addTool({
      tool: McpSchema.Tool.make({
        name: "show_dossier",
        title: "Show Gauntlet Dossier",
        description: SHOW_DOSSIER_DESCRIPTION,
        inputSchema,
        outputSchema,
        annotations: {
          title: "Show Gauntlet Dossier",
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
        // Unconditional: a host that renders Apps may not declare the extension.
        _meta: { ui: { resourceUri: DOSSIER_APP_URI } },
      }),
      annotations: Context.empty(),
      handle: (payload) =>
        Schema.decodeUnknownEffect(ShowDossierParameters)(payload).pipe(
          Effect.mapError((cause) => McpSchema.InvalidParams.make({ message: cause.message })),
          Effect.flatMap(({ run_dir }) => showDossier(run_dir)),
          Effect.catchTag("DossierUnavailable", (failure) =>
            Effect.succeed(McpSchema.CallToolResult.make({
              isError: true,
              content: [{ type: "text", text: failure.message }],
            }))),
        ),
    })
  }),
)

const dossierApp = Layer.unwrap(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const contentDirectory = yield* ContentDirectory

    return McpServer.resource({
      uri: DOSSIER_APP_URI,
      name: "Gauntlet Dossier",
      description: "Shows the result of show_dossier",
      mimeType: MCP_APP_MIME_TYPE,
      content: fs.readFileString(`${contentDirectory}/apps/dossier.html`).pipe(
        Effect.map((text) => ({
          contents: [{ uri: DOSSIER_APP_URI, mimeType: MCP_APP_MIME_TYPE, text }],
        })),
      ),
    })
  }),
)

// Registrations only, so the in-memory test client and the stdio transport
// serve the same server.
export const displayRegistrations = Layer.mergeAll(showDossierTool, dossierApp)

export const DISPLAY_PROTOCOLS = [
  McpProtocol.v2026_07_28,
  McpProtocol.v2025_11_25,
  McpProtocol.v2025_06_18,
  McpProtocol.v2025_03_26,
] as const

export const displayServerStdio = McpServer.layerStdio({
  name: "gauntlet",
  version: gauntletVersion,
  protocols: DISPLAY_PROTOCOLS,
  registrations: displayRegistrations,
})
