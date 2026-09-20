import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import type { Candidate } from "../domain/candidate.ts"

export interface SourceFile {
  readonly file: string
  readonly text: string
}

export interface SourceOmission {
  readonly candidateId: string
  readonly file?: string
  readonly reason: string
}

export interface SourceContext {
  readonly files: ReadonlyArray<SourceFile>
  readonly omissions: ReadonlyArray<SourceOmission>
  readonly characters: number
}

// Source-only character budget, not a promise that a complete Jev request fits.
// Callers own the remaining prompt budget and must persist this result with it.
const MAX_SOURCE_BYTES = FileSystem.MiB(1)

// The caller supplies the Run's frozen review directory, including its working
// tree overlay. Never substitute the current checkout or headCommit alone.
// This helper is intentionally not wired into Pool or Verification yet.
export const assembleSourceContext = Effect.fn(
  "gauntlet.source_context.assemble",
)(function* (snapshotRoot: string, candidates: ReadonlyArray<Candidate>, maxCharacters: number) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const root = yield* fs.realPath(snapshotRoot)
  const files: Array<SourceFile> = []
  const seen = new Set<string>()
  const omissions: Array<SourceOmission> = []
  let characters = 0

  for (const candidate of candidates) {
    const references = candidate.sourceReferences ?? []
    if (references.length === 0) {
      omissions.push({ candidateId: candidate.id, reason: "no source references" })
    }
    for (const file of references) {
      const omit = (reason: string) => {
        omissions.push({ candidateId: candidate.id, file, reason })
      }
      const parts = file.split("/")
      if (
        path.isAbsolute(file) || /^[A-Za-z]:/.test(file) ||
        file.includes("\\") ||
        parts.some((part) => part === ".." || part === ".git" || part === "")
      ) {
        omit("path is not repository-relative source")
        continue
      }
      const resolved = yield* fs.realPath(path.join(root, file)).pipe(Effect.result)
      if (Result.isFailure(resolved)) {
        if (Predicate.isTagged("NotFound")(resolved.failure.reason)) {
          omit("file is missing from the review snapshot")
          continue
        }
        return yield* resolved.failure
      }
      const relative = path.relative(root, resolved.success)
      if (
        relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) ||
        path.isAbsolute(relative) || relative.split(path.sep).includes(".git")
      ) {
        omit("resolved path is outside repository source")
        continue
      }
      if (seen.has(relative)) continue
      seen.add(relative)
      const info = yield* fs.stat(resolved.success)
      if (info.type !== "File" || info.size > MAX_SOURCE_BYTES) {
        omit("source is not a regular file within the 1 MiB read limit")
        continue
      }
      const text = yield* fs.readFileString(resolved.success)
      if (text.includes("\0")) {
        omit("source contains binary data")
        continue
      }
      if (characters + text.length > maxCharacters) {
        omit("whole file exceeds the remaining source character budget")
        continue
      }
      files.push({ file: relative.split(path.sep).join("/"), text })
      characters += text.length
    }
  }
  return { files, omissions, characters } satisfies SourceContext
})
