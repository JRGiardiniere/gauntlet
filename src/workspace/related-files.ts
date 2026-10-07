import { isUtf8 } from "node:buffer"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { runGit } from "../target/git.ts"
import type { SourceFile } from "./source-context.ts"

// The opt-in related-file context for Finders (#134): the whole post-change
// text of every touched file, plus the unchanged source files most related
// to them — files a touched file imports and files importing a touched file,
// tests included. Measured on seeded-bugs-2: 3.7/7 → 5.3/7.
export interface RelatedFiles {
  readonly touched: ReadonlyArray<SourceFile>
  readonly related: ReadonlyArray<SourceFile>
}

const JS_SOURCE = /\.[cm]?[jt]sx?$/

// A quoted relative module path (`"./x"`, `'../y/z.ts'`), the way ES
// imports, re-exports, dynamic imports and require spell one.
const RELATIVE_SPECIFIER = /["'](\.\.?\/[^"'\s]+)["']/g

export const gatherRelatedFiles = Effect.fn("RelatedFiles.gather")(function* (
  snapshotRoot: string,
  changedFiles: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  // A file the change deletes, or a listed path that is not a readable text
  // file, has no text to show. Related files are optional context, so a file
  // that cannot be read for any reason (a submodule's empty directory, an
  // error the Claude Code host cannot tag) is skipped and logged.
  const readText = (file: string) =>
    fs.readFile(path.join(snapshotRoot, file)).pipe(
      Effect.map((bytes) =>
        isUtf8(bytes) && !bytes.includes(0)
          ? Option.some({ file, text: new TextDecoder().decode(bytes) })
          : Option.none<SourceFile>()
      ),
      Effect.catch((error) =>
        Effect.log(`related files: skipped ${file}: ${error.message}`).pipe(
          Effect.as(Option.none<SourceFile>()),
        )
      ),
    )
  const readAll = (files: ReadonlyArray<string>) =>
    Effect.forEach(files, readText, { concurrency: 32 }).pipe(
      Effect.map((read) => read.flatMap(Option.toArray)),
    )

  // Tracked plus untracked-but-not-ignored: a working-tree overlay adds its
  // new files to the snapshot without adding them to the index.
  const listed = (yield* runGit(snapshotRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])).split("\0").filter((file) => file !== "")
  const known = new Set([...listed, ...changedFiles])
  const resolve = (from: string, specifier: string) => {
    const base = path.join(path.dirname(from), specifier)
    const bare = base.replace(/\.[cm]?js$/, "")
    return [
      base,
      `${bare}.ts`,
      `${bare}.tsx`,
      `${bare}.js`,
      path.join(base, "index.ts"),
      path.join(base, "index.js"),
    ].find((candidate) => known.has(candidate))
  }
  const importsOf = ({ file, text }: SourceFile) =>
    [...text.matchAll(RELATIVE_SPECIFIER)].flatMap((match) =>
      Option.toArray(Option.fromUndefinedOr(resolve(file, match[1] ?? "")))
    )

  const touchedSet = new Set(changedFiles)
  const touched = yield* readAll(changedFiles)
  const sources = yield* readAll(
    listed.filter((file) => JS_SOURCE.test(file) && !touchedSet.has(file)),
  )
  const imported = new Set(touched.flatMap(importsOf))
  const related = sources
    .filter((source) =>
      imported.has(source.file) ||
      importsOf(source).some((file) => touchedSet.has(file))
    )
    .sort((a, b) => a.file.localeCompare(b.file))
  return { touched, related } satisfies RelatedFiles
})
