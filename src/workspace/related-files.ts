import { isUtf8 } from "node:buffer"
import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import { runGit } from "../target/git.ts"
import type { SourceFile } from "./source-context.ts"

// The opt-in related-file context for Finders (#134, #140): the whole
// post-change text of every touched file, plus the unchanged files linked to
// them by a path-shaped reference in either direction, or by a type-like name
// in the same directory, kept within one character budget.
export interface RelatedFiles {
  readonly touched: ReadonlyArray<SourceFile>
  readonly related: ReadonlyArray<SourceFile>
}

// About 60K tokens. A single file over a quarter of it is never kept.
export const RELATED_FILES_BUDGET = 240_000
const LARGEST_RELATED_FILE = RELATED_FILES_BUDGET / 4
// A path suffix naming more files than this says nothing.
const AMBIGUOUS = 3

// A quoted relative path (`"./x"`, `'../y/z.ts'`), as JS imports spell one.
const RELATIVE_SPECIFIER = /["'`](\.\.?\/[^"'`\s]+)["'`]/g
// A qualified name whose tail mirrors a file path: `App\Http\Foo`,
// `app.models.user`, `crate::a::b`, `foo/bar`. Strings may double `\`. It
// starts only at a word's start, so a long word costs linear time, not
// quadratic.
const QUALIFIED_NAME = /(?<![\w$-])[A-Za-z_$][\w$-]*(?:(?:\\\\?|\/|::|\.)[A-Za-z_$][\w$-]*)+/g
const SEPARATOR = /\\\\?|\/|::|\./
// PascalCase or multi-word: a stem that names a type, not a common word.
const TYPE_LIKE = /^[A-Z][a-z]|[a-z\d][A-Z]|[A-Za-z\d][_-][A-Za-z\d]/

const extensionless = (file: string) => file.replace(/\.[^./]+$/, "")
const segment = (name: string) => name.toLowerCase().replace(/[_-]/g, "")
const mentions = (text: string, word: string) =>
  new RegExp(`(?<![\\w$])${word.replace(/[^\w]/g, "\\$&")}(?![\\w$])`).test(text)
const indexBy = (
  files: ReadonlyArray<string>,
  keys: (file: string) => ReadonlyArray<string>,
) => {
  const index = new Map<string, Array<string>>()
  for (const file of files) {
    for (const key of keys(file)) {
      const bucket = index.get(key)
      if (bucket === undefined) index.set(key, [file])
      else bucket.push(file)
    }
  }
  return index
}

export const gatherRelatedFiles = Effect.fn("RelatedFiles.gather")(function* (
  snapshotRoot: string,
  changedFiles: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const stem = (file: string) => path.basename(extensionless(file))

  // Optional context: a file the change deleted, a binary file, or one that
  // cannot be read is left out; only the last is worth a log line.
  const readText = (file: string) =>
    fs.readFile(path.join(snapshotRoot, file)).pipe(
      Effect.map((bytes) =>
        isUtf8(bytes) && !bytes.includes(0)
          ? Option.some({ file, text: new TextDecoder().decode(bytes) })
          : Option.none<SourceFile>()
      ),
      Effect.catch((error) =>
        Predicate.isTagged(error.reason, "NotFound")
          ? Effect.succeedNone
          : Effect.logWarning(`related file skipped, unreadable: ${file}`, error)
            .pipe(Effect.as(Option.none<SourceFile>()))
      ),
    )
  const readAll = (files: Iterable<string>) =>
    Effect.forEach(files, readText, { concurrency: 32 }).pipe(
      Effect.map((read) => Array.flatMap(read, Option.toArray)),
    )

  // Tracked plus untracked-but-not-ignored: a working-tree overlay adds its
  // new files to the snapshot without adding them to the index.
  const listed = Array.filter((yield* runGit(snapshotRoot, [
    "ls-files",
    "-z",
    "--cached",
    "--others",
    "--exclude-standard",
  ])).split("\0"), (file) => file !== "")
  const known = [...new Set([...listed, ...changedFiles])]
  const byPath = indexBy(known, (file) => [extensionless(file)])
  const byDirectory = indexBy(known, (file) => [path.dirname(file)])
  const bySuffix = indexBy(known, (file) => {
    const parts = Array.map(extensionless(file).split("/"), segment)
    return Array.map(parts.slice(0, -1), (_, start) => Array.join(parts.slice(start), "/"))
  })

  const referencesOf = ({ file, text }: SourceFile) => {
    const found = new Set<string>()
    for (const [, specifier = ""] of text.matchAll(RELATIVE_SPECIFIER)) {
      const base = path.join(path.dirname(file), specifier)
      for (const key of [extensionless(base), path.join(base, "index")]) {
        for (const named of byPath.get(key) ?? []) found.add(named)
      }
    }
    for (const [name] of text.matchAll(QUALIFIED_NAME)) {
      const parts = Array.map(name.split(SEPARATOR), segment)
      // Up to two trailing member segments: `Foo\Bar::baz`, `mod.fn`.
      for (let drop = 0; drop <= 2 && parts.length - drop >= 2; drop++) {
        const head = parts.slice(0, parts.length - drop)
        const named = Array.findFirst(head.slice(0, -1), (_, start) =>
          Option.fromUndefinedOr(bySuffix.get(Array.join(head.slice(start), "/"))))
        if (Option.isSome(named) && named.value.length <= AMBIGUOUS) {
          Array.forEach(named.value, (each) => found.add(each))
          break
        }
      }
    }
    found.delete(file)
    return found
  }

  // A file mentioning a touched file's stem, or the stem without `_`/`-`, is
  // a candidate referrer; nothing beyond these hits is read.
  const mentioning = (file: string) => {
    const words = [...new Set([stem(file), stem(file).replace(/[_-]/g, "")])]
    return runGit(snapshotRoot, [
      "grep", "-l", "-z", "-I", "-i", "-w", "-F", "--untracked",
      ...Array.flatMap(words, (word) => ["-e", word]),
    ]).pipe(
      Effect.catchIf((error) => error.exitCode === 1, () => Effect.succeed("")),
      Effect.map((out) => Array.filter(out.split("\0"), (hit) => hit !== "")),
    )
  }

  const touchedSet = new Set(changedFiles)
  const touched = yield* readAll(changedFiles)
  const hits = yield* Effect.forEach(changedFiles, mentioning, { concurrency: 8 })
  const texts = new Map(
    Array.map([...touched, ...(yield* readAll(new Set(Array.filter(hits.flat(), (hit) => !touchedSet.has(hit)))))], ({ file, text }) => [file, text]),
  )
  const links = new Map<string, Set<string>>()
  const dependencies = new Set<string>()
  const link = (file: string, to: string) => {
    if (!touchedSet.has(file)) links.set(file, (links.get(file) ?? new Set()).add(to))
  }
  Array.forEach(changedFiles, (file, i) => {
    const text = texts.get(file)
    if (text !== undefined) {
      referencesOf({ file, text }).forEach((named) => {
        link(named, file)
        dependencies.add(named)
      })
      for (const sibling of byDirectory.get(path.dirname(file)) ?? []) {
        if (TYPE_LIKE.test(stem(sibling)) && mentions(text, stem(sibling))) link(sibling, file)
      }
    }
    for (const hit of hits[i] ?? []) {
      const hitText = texts.get(hit)
      if (hitText === undefined || hit === file) continue
      const sibling = path.dirname(hit) === path.dirname(file) &&
        TYPE_LIKE.test(stem(file)) && mentions(hitText, stem(file))
      if (sibling || referencesOf({ file: hit, text: hitText }).has(file)) link(hit, file)
    }
  })

  // A touched file's own dependencies first, then referrers and siblings;
  // within each, most distinct touched files linked, then smallest, so more
  // files fit. Rendered in path order so the cached prompt prefix stays stable.
  const unread = yield* readAll(Array.filter([...links.keys()], (file) => !texts.has(file)))
  Array.forEach(unread, ({ file, text }) => texts.set(file, text))
  const size = (file: string) => texts.get(file)?.length ?? 0
  const tier = (file: string) => (dependencies.has(file) ? 0 : 1)
  const ranked = Array.map([...links]
    .sort(([a, x], [b, y]) =>
      tier(a) !== tier(b)
        ? tier(a) - tier(b)
        : x.size !== y.size
        ? y.size - x.size
        : size(a) !== size(b)
        ? size(a) - size(b)
        : a.localeCompare(b)
    ), ([file]) => file)
  const kept: Array<SourceFile> = []
  let chars = 0
  for (const file of ranked) {
    const text = texts.get(file)
    if (text === undefined || text.length > LARGEST_RELATED_FILE) continue
    if (chars + text.length > RELATED_FILES_BUDGET) break
    kept.push({ file, text })
    chars += text.length
  }
  yield* Effect.log("related files gathered", { linked: ranked.length, kept: kept.length, chars })
  const related = kept.sort((a, b) => a.file.localeCompare(b.file))
  return { touched, related } satisfies RelatedFiles
})
