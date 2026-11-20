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
// reviewed version has is linked from the Caller's checkout, never copied or
// installed. Nothing else the checkout ignores is exposed.

export const DEPENDENCIES = "node_modules"

const LOCKFILES = ["bun.lock", "bun.lockb", "package-lock.json", "pnpm-lock.yaml", "yarn.lock"]

export interface InstalledDependencies {
  // Snapshot-relative package roots whose `node_modules` was linked; "" is
  // the repository root.
  readonly exposed: ReadonlyArray<string>
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

  // Tracked content wins: a `node_modules` the snapshot already has is left
  // as it is, and a package root it no longer has gets nothing.
  const exposeAt = (root: string) =>
    fs.symlink(path.join(target.repoRoot, root, DEPENDENCIES), path.join(snapshot, root, DEPENDENCIES)).pipe(
      Effect.as([root]),
      Effect.catchReason("PlatformError", "AlreadyExists", () => Effect.succeed([])),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed([])),
      Effect.mapError((cause) => failure(`could not expose ${joinRelative(root, DEPENDENCIES)} in the review snapshot`, cause)),
    )

  const installed = yield* Effect.filter(roots, installedAt)
  const exposed = yield* Effect.forEach(installed, exposeAt).pipe(Effect.map(Array.flatten))

  const readIfPresent = (file: string) =>
    fs.readFile(file).pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.undefined))

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
    Array.flatMap(exposed, (root) => Array.map(LOCKFILES, (name) => [root, name] as const)),
    ([root, name]) => compare(root, name),
    { concurrency: "unbounded" },
  ).pipe(Effect.map(Array.flatten))

  return { exposed, missing: manifests.length > 0 && installed.length === 0, lockfileWarnings } satisfies InstalledDependencies
})
