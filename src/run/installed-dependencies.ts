import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import { ReviewTarget } from "../domain/review-target.ts"
import { describeGitFailure, runGit } from "../target/git.ts"
import { RunError } from "./run-record.ts"

// The Caller's installed dependencies, exposed read-only in a Run's snapshot:
// the `node_modules` at the repository root and beside each package.json the
// head commit tracks is linked from the Caller's checkout, never copied or
// installed. The fence admits a read whose real path lies in one of these
// directories (src/host/opencode-agents.ts); nothing else ignored is exposed.

export const DEPENDENCIES = "node_modules"

// Where package managers keep the packages themselves. Every other dot-entry
// directly in a `node_modules` is tool state (`.cache`, `.mf`, `.vite`), which
// can hold account details and is never served.
const PACKAGE_STORES = [".bin", ".bun", ".pnpm"]

// `relative` is a `/`-separated path with `node_modules` among its segments.
export const isDependencyToolState = (relative: string): boolean => {
  const segments = relative.split("/")

  return Array.some(segments, (segment, index) =>
    index > 0 && segments[index - 1] === DEPENDENCIES && segment.startsWith(".") && !Array.contains(PACKAGE_STORES, segment))
}

const LOCKFILES =["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]

export interface ExposedDependencies {
  // Snapshot-relative package root; "" is the repository root.
  readonly root: string
  // The real path of the Caller's `node_modules` there.
  readonly directory: string
}

export interface InstalledDependencies {
  readonly exposed: ReadonlyArray<ExposedDependencies>
  // The reviewed version has a package.json, yet the Caller's checkout has no
  // `node_modules` at any of its package roots.
  readonly missing: boolean
  // Lockfiles at an exposed root that differ between the reviewed version and
  // the Caller's checkout, which the exposed dependencies were installed from.
  readonly lockfileWarnings: ReadonlyArray<string>
}

const isManifest = (file: string) =>
  (file === "package.json" || file.endsWith("/package.json")) && !Array.contains(file.split("/"), DEPENDENCIES)

const joinRelative = (root: string, name: string) => (root === "" ? name : `${root}/${name}`)

const sameBytes = (left: Uint8Array, right: Uint8Array) =>
  left.length === right.length && left.every((byte, index) => byte === right[index])

// Links the Caller's `node_modules` into the snapshot at `snapshot`, after any
// working-tree overlay is applied: the snapshot is then the reviewed version
// the lockfiles are compared against. The links go with the snapshot, and
// removing a link never touches what it points to.
export const exposeInstalledDependencies = Effect.fn("InstalledDependencies.expose")(function* (
  target: ReviewTarget,
  runId: string,
  snapshot: string,
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  const failure = (reason: string, cause?: unknown) =>
    RunError.make({ operation: "execute-plan", reason, runId, cause })

  const tracked = yield* runGit(target.repoRoot, ["ls-tree", "-r", "-z", "--name-only", target.headCommit]).pipe(
    Effect.mapError((cause) => failure(describeGitFailure("could not list the reviewed package roots", cause), cause)),
  )

  // A working-tree review also has the manifests its overlay adds.
  const overlaid = ReviewTarget.match(target, {
    WorkingTree: ({ changedFiles, untrackedFiles }) => [...changedFiles, ...untrackedFiles],
    Commits: () => [],
    PullRequest: () => [],
  })

  const manifests = Array.filter(Array.dedupe([...tracked.split("\0"), ...overlaid]), isManifest)

  const roots = Array.dedupe(["", ...Array.map(manifests, (file) => file.slice(0, Math.max(file.lastIndexOf("/"), 0)))])

  // A `node_modules` the process cannot stat cannot be read by a tool
  // either, so for the review it is not installed.
  const installedAt = (root: string) =>
    fs.stat(path.join(target.repoRoot, root, DEPENDENCIES)).pipe(
      Effect.map((info) => info.type === "Directory"),
      Effect.orElseSucceed(() => false),
    )

  const realSnapshot = yield* fs.realPath(snapshot).pipe(
    Effect.mapError((cause) => failure(`could not resolve the review snapshot ${snapshot}`, cause)),
  )

  // A package root reached through a link (an overlay can turn a directory
  // into one) would put the new link outside the snapshot.
  const insideSnapshot = (root: string) =>
    fs.realPath(path.join(snapshot, root)).pipe(
      Effect.map((real) => real === path.join(realSnapshot, root)),
      Effect.orElseSucceed(() => false),
    )

  const exposeAt = (root: string) =>
    Effect.gen(function* () {
      const source = path.join(target.repoRoot, root, DEPENDENCIES)

      if (!(yield* insideSnapshot(root))) return []

      // The fence admits everything below this real path, so a checkout
      // `node_modules` linked to some other kind of directory is not exposed.
      const directory = yield* fs.realPath(source).pipe(
        Effect.mapError((cause) => failure(`could not resolve ${source}`, cause)),
      )

      if (path.basename(directory) !== DEPENDENCIES) return []

      // Tracked content wins: a `node_modules` the snapshot already has is
      // left as it is, and a package root it no longer has gets nothing.
      const linked = yield* fs.symlink(source, path.join(snapshot, root, DEPENDENCIES)).pipe(
        Effect.as(true),
        Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed(false)),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(false)),
        Effect.mapError((cause) => failure(`could not expose ${joinRelative(root, DEPENDENCIES)} in the review snapshot`, cause)),
      )

      return linked ? [{ root, directory }] : []
    })

  const installed = yield* Effect.filter(roots, installedAt)
  const exposed = yield* Effect.forEach(installed, exposeAt).pipe(Effect.map(Array.flatten))

  // Only a regular file is read: a tracked link named like a lockfile could
  // point at anything on disk.
  const readIfPresent = (file: string) =>
    Effect.gen(function* () {
      const kind = yield* fs.lstat(file).pipe(
        Effect.map((info): string | undefined => info.type),
        Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined),
      )

      if (kind === undefined) return undefined

      if (kind !== "File") return yield* failure(`${file} is not a regular file`)

      return yield* fs.readFile(file)
    })

  const consequence = "so dependency reads may not match the reviewed version"

  // An unreadable lockfile is a warning, never a failed review.
  const compare = (root: string, name: string) =>
    Effect.gen(function* () {
      const file = joinRelative(root, name)

      const sides = yield* Effect.all(
        [readIfPresent(path.join(snapshot, file)), readIfPresent(path.join(target.repoRoot, file))],
        { concurrency: 2 },
      ).pipe(Effect.option)

      if (Option.isNone(sides)) return [`${file} could not be read to compare it with your checkout, ${consequence}`]
      const [reviewed, checkoutLockfile] = sides.value

      if (reviewed === undefined && checkoutLockfile === undefined) return []

      if (reviewed === undefined) return [`${file} is in your checkout but not in the reviewed version, ${consequence}`]

      if (checkoutLockfile === undefined) return [`${file} is in the reviewed version but not in your checkout, ${consequence}`]

      return sameBytes(reviewed, checkoutLockfile) ? [] : [`${file} differs between the reviewed version and your checkout, ${consequence}`]
    })

  const lockfileWarnings = yield* Effect.forEach(
    Array.flatMap(exposed, ({ root }) => Array.map(LOCKFILES, (name) => [root, name] as const)),
    ([root, name]) => compare(root, name),
    { concurrency: "unbounded" },
  ).pipe(Effect.map(Array.flatten))

  return { exposed, missing: manifests.length > 0 && installed.length === 0, lockfileWarnings } satisfies InstalledDependencies
})
