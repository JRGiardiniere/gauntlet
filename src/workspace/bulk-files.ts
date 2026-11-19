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

export interface InlinedDiff {
  readonly diff: string
  readonly omitted: ReadonlyArray<string>
}

const FILE_HEADER = "diff --git "
const NEW_PATH = " b/"

// The diff as it is inlined: each lockfile's section, from its
// `diff --git a/<old> b/<new>` header to the next, is left out and named.
export const inlinedDiff = (diff: string): InlinedDiff => {
  const omitted: Array<string> = []
  const kept: Array<string> = []
  let skipping = false
  for (const line of diff.split("\n")) {
    if (line.startsWith(FILE_HEADER)) {
      const file = line.slice(line.lastIndexOf(NEW_PATH) + NEW_PATH.length)
      skipping = isLockfile(file)
      if (skipping) omitted.push(file)
    }
    if (!skipping) kept.push(line)
  }
  return { diff: Array.join(kept, "\n"), omitted }
}

// The note that follows an inlined diff with lockfiles left out.
export const omittedLockfilesNote = (omitted: ReadonlyArray<string>): string =>
  omitted.length === 0
    ? ""
    : `\n\nLeft out of the diff as lockfiles (read them if the review needs them): ${Array.join(omitted, ", ")}`
