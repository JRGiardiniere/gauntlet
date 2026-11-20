import * as Array from "effect/Array"

// Bulk files a change touches stay out of what Finders and Stages are handed
// inline (the diff, touched files, related files): their text is generated
// and can be larger than the rest of the change. Agents can still read them.
// One list of lockfile names; size is capped where whole files are inlined.
export const LOCKFILE_NAMES: ReadonlySet<string> = new Set([
  "bun.lock",
  "bun.lockb",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "deno.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "go.sum",
  "flake.lock",
  "mix.lock",
  "pubspec.lock",
  "Podfile.lock",
  "Package.resolved",
  "packages.lock.json",
  "gradle.lockfile",
])

export const isLockfile = (file: string): boolean =>
  LOCKFILE_NAMES.has(file.slice(file.lastIndexOf("/") + 1))

interface InlinedDiff {
  readonly diff: string
  readonly omitted: ReadonlyArray<string>
}

const FILE_HEADER = "diff --git "

// Where a file's changed text starts, after its extended header lines
// (`new file mode`, `deleted file mode`, `index`, renames).
const BODY = ["--- ", "+++ ", "@@", "Binary files ", "GIT binary patch"]

// The new path of a `diff --git a/<old> b/<new>` header: its last token, as
// git may quote it or (diff.noprefix) leave off the `b/`. A path with spaces
// keeps only its last segment's tail, which still names a lockfile.
const headerPath = (line: string) => {
  const last = line.slice(line.lastIndexOf(" ") + 1).replace(/^"|"$/g, "")

  return last.startsWith("b/") ? last.slice(2) : last
}

// The diff as it is inlined: each lockfile keeps its header lines, which say
// whether it was added, deleted or changed, and loses its changed text.
export const inlinedDiff = (diff: string): InlinedDiff => {
  const omitted: Array<string> = []
  const kept: Array<string> = []
  let lockfile = false
  let inBody = false

  for (const line of diff.split("\n")) {
    if (line.startsWith(FILE_HEADER)) {
      const file = headerPath(line)
      lockfile = isLockfile(file)
      inBody = false

      if (lockfile) omitted.push(file)
    } else if (lockfile && !inBody && Array.some(BODY, (start) => line.startsWith(start))) {
      inBody = true
    }

    if (!(lockfile && inBody)) kept.push(line)
  }

  return { diff: Array.join(kept, "\n"), omitted }
}

// The note that follows an inlined diff with lockfiles left out.
export const omittedLockfilesNote = (omitted: ReadonlyArray<string>): string =>
  omitted.length === 0
    ? ""
    : `\n\nLockfiles appear above by their headers only, with their changed lines left out: ${
      Array.join(omitted, ", ")
    }. Read one if the review needs it.`
