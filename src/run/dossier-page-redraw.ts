import * as Arr from "effect/Array"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Schema from "effect/Schema"
import { Dossier } from "../domain/dossier.ts"
import { briefReferences, sourceKey } from "../render/brief.ts"
import {
  DossierPageData,
  renderDossierPage,
} from "../render/dossier-page.ts"
import { runGit } from "../target/git.ts"
import { describeArtifactWrite, writeArtifactText } from "./artifact.ts"
import type { LoadedRun } from "./run-record.ts"

export class PageError extends Data.TaggedError("PageError")<{
  readonly reason: string
  readonly cause?: unknown
}> {}

export interface RedrawnPage {
  readonly path: string
  readonly problems: ReadonlyArray<string>
}

const unreadable = (what: string) => (cause: { readonly message: string }) =>
  new PageError({ reason: `${what}: ${cause.message.replace(/\s+/g, " ")}`, cause })

// Redraws a Run's dossier.html with the briefs in its briefs/ directory. The
// exhibits come from page-data.json, so they stay what the Run saw; a
// brief's code that it doesn't carry is read from git, at the reviewed head
// or at the commit the brief names.
export const redrawDossierPage = Effect.fn("DossierPage.redraw")(function* (
  { paths, plan }: LoadedRun,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const dossier = yield* fs.readFileString(paths.dossier).pipe(
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Dossier))),
    Effect.mapError(unreadable(`could not read ${paths.dossier}`)),
  )
  const dataText = yield* fs.readFileString(paths.pageData).pipe(
    Effect.mapError((cause) =>
      new PageError({
        reason: Predicate.isTagged("NotFound")(cause.reason)
          ? `run ${plan.runId} has no page-data.json; it predates the page`
          : `could not read ${paths.pageData}: ${cause.message}`,
        cause,
      })
    ),
  )
  const data = yield* Schema.decodeEffect(Schema.fromJsonString(DossierPageData))(
    dataText,
  ).pipe(Effect.mapError(unreadable(`${paths.pageData} is corrupt`)))

  const directory = path.join(paths.root, "briefs")
  const listed = yield* fs.readDirectory(directory, { recursive: true }).pipe(
    Effect.catch((cause) =>
      Predicate.isTagged(cause.reason, "NotFound")
        ? Effect.succeed<ReadonlyArray<string>>([])
        : Effect.fail(unreadable(`could not list ${directory}`)(cause))
    ),
  )
  const briefs = new Map<string, string>()
  for (const file of listed.filter((name) => name.endsWith(".md")).sort()) {
    const text = yield* fs.readFileString(path.join(directory, file)).pipe(
      Effect.mapError(unreadable(`could not read briefs/${file}`)),
    )
    briefs.set(file.slice(0, -".md".length), text)
  }

  // A working-tree Run reviewed its changed files with uncommitted edits the
  // head commit lacks, so only the page's own copy shows them as reviewed.
  const uncommitted = new Set(
    plan.target._tag === "WorkingTree" ? [...plan.target.changedFiles, ...plan.target.untrackedFiles] : [],
  )
  const wanted = new Map(
    [...briefs.values()].flatMap(briefReferences)
      .filter(({ file, revision }) =>
        revision !== undefined || (data.sources[file] === undefined && !uncommitted.has(file))
      )
      .map(({ file, revision }) => [sourceKey(file, revision), { file, revision }] as const),
  )
  const read = yield* Effect.forEach(wanted, ([key, { file, revision }]) =>
    runGit(dossier.target.repoRoot, ["show", `${revision ?? dossier.target.headCommit}:${file}`]).pipe(
      Effect.map((text) => [key, text.replace(/\n$/, "").split("\n")] as const),
      Effect.option,
    ), { concurrency: "unbounded" })
  const extraSources = new Map(Arr.getSomes(read))

  const drawn = renderDossierPage({
    plan,
    dossier,
    data,
    runDirectory: paths.root,
    briefs,
    extraSources,
  })
  yield* writeArtifactText(paths.dossierPage, drawn.html).pipe(
    Effect.mapError((failure) => new PageError({ reason: describeArtifactWrite(failure), cause: failure })),
  )
  return { path: paths.dossierPage, problems: drawn.problems } satisfies RedrawnPage
})
