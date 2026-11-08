import * as Array from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { isCompiledBinary } from "../content/lens.ts"
import { readPromptTemplate, renderPromptTemplate } from "../content/prompt-template.ts"
import { Dossier } from "../domain/dossier.ts"
import { noun } from "../render/dossier-page.ts"
import { viewDossier } from "../render/dossier-view.ts"
import type { LoadedRun } from "./run-record.ts"

export class BriefError extends Data.TaggedError("BriefError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

// The instructions for writing one finding's brief live here, not in the
// gauntlet-cli skill: only the agent asked for a brief needs them.
const templatePath = isCompiledBinary
  ? `${import.meta.dirname}/src/run/brief.md`
  : `${import.meta.dirname}/brief.md`

export const briefRequest = Effect.fn("Brief.request")(function* (
  { paths, plan }: LoadedRun,
  findingId: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dossier = yield* fs.readFileString(paths.dossier).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
    Effect.mapError((cause) =>
      new BriefError({ reason: `could not read ${paths.dossier}: ${cause.message}`, cause })
    ),
  )
  const view = viewDossier(dossier)
  const found = Array.findFirst([...view.findings, ...view.unresolved], ({ candidate }) =>
    candidate.id === findingId)
  if (Option.isNone(found)) {
    return yield* new BriefError({
      reason: `run ${plan.runId} has no finding or unresolved Candidate ${findingId}`,
    })
  }
  const entry = found.value
  const { file, line } = entry.candidate
  const template = yield* readPromptTemplate(templatePath)
  return yield* renderPromptTemplate("brief", template, [
    ["SUBJECT", noun(entry)],
    ["FINDING_ID", findingId],
    ["LOCATION", line === undefined ? file : `${file}:${line}`],
    ["RUN_ID", plan.runId],
    ["RUN_DIRECTORY", paths.root],
    ["BRIEF_PATH", path.join(paths.root, "briefs", `${findingId}.md`)],
    ["REPO_ROOT", dossier.target.repoRoot],
    ["HEAD_COMMIT", dossier.target.headCommit],
  ])
})
