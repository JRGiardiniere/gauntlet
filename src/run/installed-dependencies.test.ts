import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Record from "effect/Record"
import { ReviewTarget } from "../domain/review-target.ts"
import { resolveCommitsTarget } from "../target/commits.ts"
import { resolveWorkingTreeTarget } from "../target/working-tree.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { exposeInstalledDependencies } from "./installed-dependencies.ts"
import { acquireReviewWorkingDirectory, captureWorkspaceOverlay } from "./review-working-directory.ts"

const RUN_ID = "installed-dependencies-test"

const NO_OVERLAY = "/nonexistent/workspace-overlay.patch"

const writeFiles = (repo: string, files: Record.ReadonlyRecord<string, string>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    for (const [file, text] of Record.toEntries(files)) {
      yield* fs.makeDirectory(path.dirname(path.join(repo, file)), { recursive: true })
      yield* fs.writeFileString(path.join(repo, file), text)
    }
  })

// A repository whose head commit tracks package roots at the top and under
// `packages/` and `vendored/`; `vendored` commits its own node_modules.
const makeRepo = (tracked: Record.ReadonlyRecord<string, string>) =>
  Effect.gen(function* () {
    const { repo } = yield* makeGitFixture({ prefix: "gauntlet-dependencies-" })
    yield* writeFiles(repo, { ".gitignore": "/node_modules/\npackages/*/node_modules/\ndist/\n.dev.vars\n", "README.md": "base\n" })
    yield* commitAll(repo, "base")
    yield* writeFiles(repo, { "README.md": "head\n", ...tracked })
    yield* commitAll(repo, "head")

    return repo
  })

const PACKAGES = {
  "package.json": "{}\n",
  "packages/a/package.json": "{}\n",
  "packages/b/package.json": "{}\n",
  "vendored/package.json": "{}\n",
  "vendored/node_modules/kept.js": "tracked\n",
}

const INSTALLED = {
  "node_modules/fixture-pkg/index.js": "export const installed = 1\n",
  "packages/a/node_modules/fixture-a/index.js": "export const a = 1\n",
  "vendored/node_modules/untracked.js": "installed over tracked\n",
  "packages/b/dist/out.js": "build output\n",
  ".dev.vars": "TOKEN=x\n",
}

describe("the Caller's installed dependencies in a Run snapshot", () => {
  it.effect("are linked at the root and beside each tracked package.json, under tracked content, and survive the snapshot's removal", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const repo = yield* makeRepo(PACKAGES)
      yield* writeFiles(repo, INSTALLED)
      const target = yield* resolveCommitsTarget(repo, "HEAD~1..HEAD")
      let snapshot = ""

      yield* Effect.scoped(Effect.gen(function* () {
        snapshot = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY)
        const installed = yield* exposeInstalledDependencies(target, RUN_ID, snapshot)

        expect(installed).toEqual({ missing: false, lockfileWarnings: [] })

        const seen = yield* Effect.forEach(
          [
            "node_modules/fixture-pkg/index.js",
            "packages/a/node_modules/fixture-a/index.js",
            "vendored/node_modules/kept.js",
            "vendored/node_modules/untracked.js",
            "packages/b/dist/out.js",
            ".dev.vars",
          ],
          (file) => fs.readFileString(path.join(snapshot, file)).pipe(Effect.orElseSucceed(() => "absent")),
        )

        // Tracked content wins; the Caller's other ignored files stay out.
        expect(seen).toEqual(["export const installed = 1\n", "export const a = 1\n", "tracked\n", "absent", "absent", "absent"])
      }))

      const snapshotLeft = yield* fs.exists(snapshot)
      expect(snapshotLeft).toBe(false)
      const callerFiles = yield* Effect.forEach(Record.keys(INSTALLED), (file) => fs.readFileString(path.join(repo, file)))
      expect(callerFiles).toEqual(Record.values(INSTALLED))
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("warn about each exposed root's lockfile that differs from the reviewed version or is on one side only", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const repo = yield* makeRepo({
        ...PACKAGES,
        "bun.lock": "reviewed\n",
        "package-lock.json": "reviewed\n",
        "pnpm-lock.yaml": "same\n",
        "packages/a/yarn.lock": "reviewed\n",
        "packages/b/yarn.lock": "reviewed\n",
      })

      yield* writeFiles(repo, {
        ...INSTALLED,
        "bun.lock": "installed\n",
        "yarn.lock": "installed\n",
        "packages/a/yarn.lock": "installed\n",
        // packages/b has no node_modules, so its lockfile does not matter.
        "packages/b/yarn.lock": "installed\n",
      })
      yield* fs.remove(path.join(repo, "package-lock.json"))
      yield* fs.makeDirectory(path.join(repo, "packages/a/bun.lock"))
      const target = yield* resolveCommitsTarget(repo, "HEAD~1..HEAD")
      const snapshot = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY)
      const installed = yield* exposeInstalledDependencies(target, RUN_ID, snapshot)

      const consequence = "so dependency reads may not match the reviewed version"
      expect(installed.lockfileWarnings).toEqual([
        `bun.lock differs between the reviewed version and your checkout, ${consequence}`,
        `package-lock.json is in the reviewed version but not in your checkout, ${consequence}`,
        `yarn.lock is in your checkout but not in the reviewed version, ${consequence}`,
        `packages/a/bun.lock could not be read to compare it with your checkout, ${consequence}`,
        `packages/a/yarn.lock differs between the reviewed version and your checkout, ${consequence}`,
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("take a working-tree review's package roots and lockfiles from the reviewed working tree, not its head commit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { root, repo } = yield* makeGitFixture({ prefix: "gauntlet-dependencies-wt-" })

      yield* writeFiles(repo, {
        ".gitignore": "node_modules/\n",
        "package.json": "{}\n",
        "bun.lock": "committed\n",
        "packages/old/package.json": "{}\n",
        "packages/old/index.js": "kept\n",
      })
      yield* commitAll(repo, "base")

      yield* writeFiles(repo, {
        "node_modules/fixture-pkg/index.js": "export const installed = 1\n",
        "bun.lock": "uncommitted\n",
        "packages/new/package.json": "{}\n",
        "packages/new/node_modules/fixture-new/index.js": "export const added = 1\n",
        "packages/old/node_modules/fixture-old/index.js": "export const old = 1\n",
      })
      yield* fs.remove(path.join(repo, "packages/old/package.json"))
      const target = yield* resolveWorkingTreeTarget(repo, undefined)

      if (!ReviewTarget.guards.WorkingTree(target)) return expect.unreachable()
      const overlay = path.join(root, "overlay.patch")
      const captured = yield* Effect.scoped(captureWorkspaceOverlay(target))
      yield* fs.writeFile(overlay, captured)
      const snapshot = yield* acquireReviewWorkingDirectory(target, RUN_ID, overlay)
      const installed = yield* exposeInstalledDependencies(target, RUN_ID, snapshot)

      expect(installed.lockfileWarnings).toEqual([])

      const linked = yield* Effect.forEach(
        ["node_modules", "packages/new/node_modules", "packages/old/node_modules"],
        (directory) => fs.exists(path.join(snapshot, directory)),
      )

      expect(linked).toEqual([true, true, false])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("call dependencies missing only when a package root exists and none has node_modules", () =>
    Effect.gen(function* () {
      const withManifest = yield* makeRepo({ "package.json": "{}\n" })
      const withoutManifest = yield* makeRepo({ "main.rs": "fn main() {}\n" })
      // Its only node_modules is tracked, so it is installed but not linked.
      const trackedOnly = yield* makeRepo({ "vendored/package.json": "{}\n", "vendored/node_modules/kept.js": "tracked\n" })

      const expose = (repo: string) =>
        Effect.gen(function* () {
          const target = yield* resolveCommitsTarget(repo, "HEAD~1..HEAD")
          const snapshot = yield* acquireReviewWorkingDirectory(target, RUN_ID, NO_OVERLAY)

          return yield* exposeInstalledDependencies(target, RUN_ID, snapshot)
        })

      const exposed = yield* Effect.forEach([withManifest, withoutManifest, trackedOnly], expose)
      expect(exposed).toEqual([
        { missing: true, lockfileWarnings: [] },
        { missing: false, lockfileWarnings: [] },
        { missing: false, lockfileWarnings: [] },
      ])
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
