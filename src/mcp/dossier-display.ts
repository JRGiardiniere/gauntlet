// Display-only MCP front end (#202): reviews run through the CLI, and this
// server only shows a finished Run's Dossier as an MCP App
// (`io.modelcontextprotocol/ui`) inside the chat client.
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import * as McpProtocol from "effect/ai/McpProtocol"
import * as McpServer from "effect/ai/McpServer"
import * as Tool from "effect/ai/Tool"
import * as Toolkit from "effect/ai/Toolkit"
import { gauntletVersion } from "../cli/version.ts"
import { ContentDirectory } from "../content/lens.ts"
import { Dossier } from "../domain/dossier.ts"
import { ReviewPriority } from "../domain/verdict.ts"
import { describePlatformError } from "../run/artifact.ts"
import { runPaths } from "../run/run-record.ts"
import {
  describeCoverageGap,
  entryLocation,
  entrySummary,
  tallyDossier,
} from "../render/digest.ts"
import { type DossierEntryView, viewDossier } from "../render/dossier-view.ts"
import { describeTargetShort } from "../render/target-text.ts"

export const DOSSIER_APP_URI = "ui://gauntlet/dossier.html"

export const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app"

// Findings and unresolved items only: refuted and dropped stay in dossier.md.
const DigestTag = Schema.Literals(["confirmed", "judgment", "plausible", "undecided"])

// The stdout digest's content as data: a line's worth per entry, since a
// client without the App hands this result to the model as text.
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

export const ShowDossier = Tool.make("show_dossier", {
  description:
    "Show a finished Gauntlet review's Dossier: the tally, each finding and unresolved item with its " +
    "Review Priority and location, and coverage gaps. `run_dir` is the absolute path of the Run " +
    "directory, the one holding dossier.json and dossier.md (the digest's last line names dossier.md in it).",
  parameters: Schema.Struct({
    run_dir: Schema.String.annotate({
      description: "Absolute path of the Run directory that holds dossier.json",
    }),
  }),
  success: DossierDigest,
  failure: DossierUnavailable,
})
  .annotate(Tool.Title, "Show Gauntlet Dossier")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false)
  // Unconditional: a host that renders Apps may not declare the extension.
  .annotate(Tool.Meta, { ui: { resourceUri: DOSSIER_APP_URI } })

export const DisplayToolkit = Toolkit.make(ShowDossier)

const unavailable = (message: string) => DossierUnavailable.make({ message })

const toolHandlers = DisplayToolkit.toLayer(
  Effect.gen(function* () {
    // Handler services are captured here: MCP treats a handler's own
    // requirements as per-request.
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    return {
      show_dossier: Effect.fn("DossierDisplay.showDossier")(function* ({ run_dir }) {
        const runDir = path.resolve(run_dir)
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

        return digestDossier(dossier, paths.dossierMarkdown)
      }),
    }
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
export const displayRegistrations = Layer.mergeAll(
  McpServer.toolkit(DisplayToolkit).pipe(Layer.provide(toolHandlers)),
  dossierApp,
)

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
