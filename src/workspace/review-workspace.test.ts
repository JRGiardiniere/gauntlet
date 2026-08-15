import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import type { ReadToolInput } from "@earendil-works/pi-coding-agent"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { withToolCallDeadline } from "../harness/tool-deadline.ts"
import { chompLine, runGit } from "../target/git.ts"
import { commitAll, makeGitFixture } from "../test-support/git.fixture.ts"
import { type BashArgs, makeReviewWorkspace } from "./just-bash-workspace.ts"
import {
  REVIEW_WORKSPACE_ROOT,
  type ReviewWorkspace,
} from "./review-workspace.ts"

// Capability tests at the public acquisition boundary: a real temporary git
// worktree (the shape production snapshots have, .git file included), real
// just-bash, and only the two model-facing tools — never library internals.

const APP_SOURCE = `export const add = (a: number, b: number): number => a + b
export const twice = (value: number): number => add(value, value)
`
const CALLER_SOURCE = `import { add } from "./app.ts"
export const total = add(1, 2)
`
const NOTES = "alpha beta\ngamma delta\n"

// A valid 1x1 PNG, small enough to skip Pi's auto-resize path.
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
)

// The adapter seam. Pi's execute signature derives params from each tool's
// TypeBox schema, but ReviewWorkspace erases the generic at the same SDK seam
// production uses. callOnSeam holds the one erasure; the execBashTool and
// execReadTool wrappers pair each tool with its named argument contract (the
// exported BashArgs, Pi's own ReadToolInput) so arguments cannot cross tools.
// SAFETY: the ctx parameter is passed as undefined deliberately. The only
// ctx use in either workspace tool is the read tool's optional `ctx?.model`
// non-vision image note, and undefined falls back to that note's no-model
// default; these tests assert the image attachment itself, never the note.
const callOnSeam = (
  tool: ReviewWorkspace["bashTool"] | ReviewWorkspace["readTool"],
  args: BashArgs | ReadToolInput,
  signal?: AbortSignal,
) =>
  tool.execute("workspace-test", args, signal, undefined, undefined as never)

type WorkspaceToolResult = Awaited<
  ReturnType<ReviewWorkspace["readTool"]["execute"]>
>

const asOutcome = (promise: Promise<WorkspaceToolResult>) =>
  promise.then(
    (result) => ({
      isError: false,
      text: result.content
        .flatMap((entry) =>
          entry.type === "text" && entry.text !== undefined
            ? [entry.text]
            : [],
        )
        .join("\n"),
    }),
    (cause: unknown) => ({
      isError: true,
      text: cause instanceof Error ? cause.message : String(cause),
    }),
  )

const execBashTool = (
  tool: ReviewWorkspace["bashTool"],
  args: BashArgs,
  signal?: AbortSignal,
) => Effect.promise(() => asOutcome(callOnSeam(tool, args, signal)))

const execReadTool = (
  tool: ReviewWorkspace["readTool"],
  args: ReadToolInput,
) => Effect.promise(() => asOutcome(callOnSeam(tool, args)))

// Bash output keeps its raw trailing newline (Pi's contract); trim it here
// so equality assertions stay readable. read() stays byte-exact.
const bash = (workspace: ReviewWorkspace, command: string) =>
  execBashTool(workspace.bashTool, { command }).pipe(
    Effect.map((result) => ({ ...result, text: result.text.trimEnd() })),
  )

const read = (workspace: ReviewWorkspace, args: ReadToolInput) =>
  execReadTool(workspace.readTool, args)

// A worktree snapshot exactly as acquireReviewWorkingDirectory produces one,
// plus a host file OUTSIDE the snapshot root that no guest path may reach.
const makeSnapshotFixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const { repo, root } = yield* makeGitFixture({
    prefix: "gauntlet-workspace-test-",
  })
  yield* fs.makeDirectory(path.join(repo, "src"))
  yield* fs.makeDirectory(path.join(repo, "data"))
  yield* fs.writeFileString(path.join(repo, "src", "app.ts"), APP_SOURCE)
  yield* fs.writeFileString(path.join(repo, "src", "caller.ts"), CALLER_SOURCE)
  yield* fs.writeFileString(
    path.join(repo, "data", "config.json"),
    `{"name":"fixture","values":[1,2,3]}\n`,
  )
  // Larger than both the 50KiB output cap and the shrunken overlay-memory
  // cap in the limits test.
  yield* fs.writeFileString(
    path.join(repo, "data", "blob.txt"),
    "b".repeat(262144),
  )
  yield* fs.writeFileString(path.join(repo, "notes.md"), NOTES)
  yield* fs.writeFile(
    path.join(repo, "data", "pixel.png"),
    new Uint8Array(ONE_PIXEL_PNG),
  )
  // A repository-contained symlink (must keep working) and one escaping the
  // root (must not dereference).
  yield* fs.symlink("src/app.ts", path.join(repo, "linked.txt"))
  yield* fs.symlink("../outside-secret.txt", path.join(repo, "escape-link"))
  yield* commitAll(repo, "fixture")
  yield* fs.writeFileString(
    path.join(root, "outside-secret.txt"),
    "host-only-credential\n",
  )

  const snapshot = path.join(root, "snapshot")
  const headCommit = chompLine(yield* runGit(repo, ["rev-parse", "HEAD"]))
  yield* runGit(repo, ["worktree", "add", "--detach", snapshot, headCommit])
  return { repo, root, snapshot }
})

const layer = NodeServices.layer

describe("ReviewWorkspace", () => {
  it.effect("supports representative review operations through bash", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* makeSnapshotFixture
      const workspace = yield* Effect.promise(() =>
        makeReviewWorkspace(snapshot),
      )
      expect(workspace.root).toBe(REVIEW_WORKSPACE_ROOT)

      expect(yield* bash(workspace, "pwd")).toEqual({
        isError: false,
        text: REVIEW_WORKSPACE_ROOT,
      })
      const recursiveGrep = yield* bash(workspace, `grep -rn "add" src`)
      expect(recursiveGrep.isError).toBe(false)
      expect(recursiveGrep.text).toContain("src/app.ts")
      expect(recursiveGrep.text).toContain("src/caller.ts")
      const extendedGrep = yield* bash(
        workspace,
        `grep -rEn "twice|total" src | sort`,
      )
      expect(extendedGrep.isError).toBe(false)
      expect(extendedGrep.text).toContain("twice")
      expect(extendedGrep.text).toContain("total")
      const ripgrep = yield* bash(workspace, `rg -n "twice" src`)
      expect(ripgrep.isError).toBe(false)
      expect(ripgrep.text).toContain("app.ts")
      const findExec = yield* bash(
        workspace,
        `find src -name '*.ts' -exec grep -l "add" {} \\;`,
      )
      expect(findExec.isError).toBe(false)
      expect(findExec.text).toContain("src/app.ts")
      expect(yield* bash(workspace, `sed -n '1p' notes.md`)).toEqual({
        isError: false,
        text: "alpha beta",
      })
      expect(yield* bash(workspace, `awk '{print $2}' notes.md`)).toEqual({
        isError: false,
        text: "beta\ndelta",
      })
      expect(yield* bash(workspace, `jq -r .name data/config.json`)).toEqual({
        isError: false,
        text: "fixture",
      })
      const pipeline = yield* bash(
        workspace,
        `find src -name '*.ts' | xargs grep -l "add" | sort | head -n 2`,
      )
      expect(pipeline.isError).toBe(false)
      expect(pipeline.text).toBe("src/app.ts\nsrc/caller.ts")
      const loop = yield* bash(
        workspace,
        `for f in src/*.ts; do echo "saw $f"; done`,
      )
      expect(loop.isError).toBe(false)
      expect(loop.text).toBe("saw src/app.ts\nsaw src/caller.ts")
      const redirect = yield* bash(
        workspace,
        `echo scratch-line > scratch.txt && cat scratch.txt`,
      )
      expect(redirect).toEqual({ isError: false, text: "scratch-line" })
      // A repository-contained symlink dereferences normally.
      const linked = yield* bash(workspace, `cat linked.txt`)
      expect(linked.isError).toBe(false)
      expect(linked.text).toContain("export const add")
    }).pipe(Effect.scoped, Effect.provide(layer)))

  it.effect("read mimics Pi's result contract through the overlay", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* makeSnapshotFixture
      const workspace = yield* Effect.promise(() =>
        makeReviewWorkspace(snapshot),
      )

      const relative = yield* read(workspace, { path: "src/app.ts" })
      expect(relative.isError).toBe(false)
      expect(relative.text).toBe(APP_SOURCE)
      const absolute = yield* read(workspace, {
        path: `${REVIEW_WORKSPACE_ROOT}/src/app.ts`,
      })
      expect(absolute.text).toBe(APP_SOURCE)

      const window = yield* read(workspace, {
        path: "src/app.ts",
        offset: 1,
        limit: 1,
      })
      expect(window.isError).toBe(false)
      expect(window.text).toContain("export const add")
      expect(window.text).toContain("more lines in file. Use offset=2")

      const beyondEnd = yield* read(workspace, {
        path: "src/app.ts",
        offset: 99,
      })
      expect(beyondEnd.isError).toBe(true)
      expect(beyondEnd.text).toContain("beyond end of file")

      const missing = yield* read(workspace, { path: "src/missing.ts" })
      expect(missing.isError).toBe(true)
      expect(missing.text).not.toContain(snapshot)

      // Image reads keep Pi's attachment contract through the overlay.
      const image = yield* Effect.promise(() =>
        callOnSeam(workspace.readTool, { path: "data/pixel.png" })
          .then((result) => result.content.map((entry) => entry.type)),
      )
      expect(image).toEqual(["text", "image"])
    }).pipe(Effect.scoped, Effect.provide(layer)))

  it.effect("offers no git, host execution, network, or package manager", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* makeSnapshotFixture
      const workspace = yield* Effect.promise(() =>
        makeReviewWorkspace(snapshot),
      )
      for (const command of [
        "git status",
        "git log",
        "node -e 'process.exit(0)'",
        "python3 -c 'print(1)'",
        "npm install",
        "pnpm test",
        "docker ps",
        "curl https://example.com",
        "wget https://example.com",
        "make",
      ]) {
        const result = yield* bash(workspace, command)
        expect(result.isError, command).toBe(true)
        expect(result.text, command).not.toContain(snapshot)
      }
    }).pipe(Effect.scoped, Effect.provide(layer)))

  it.effect("cannot read outside the virtual root or see .git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const { snapshot } = yield* makeSnapshotFixture
      const workspace = yield* Effect.promise(() =>
        makeReviewWorkspace(snapshot),
      )

      for (const command of [
        "cat /etc/passwd",
        "cat ../outside-secret.txt",
        `cat ${REVIEW_WORKSPACE_ROOT}/../outside-secret.txt`,
        "cat escape-link",
        `cat ${REVIEW_WORKSPACE_ROOT}/.git`,
        `ls ${REVIEW_WORKSPACE_ROOT}/.git`,
        // Case aliases reach the same host file on a case-insensitive
        // backing filesystem; each carries its own tombstone.
        "cat .GIT",
        "cat .Git",
      ]) {
        const result = yield* bash(workspace, command)
        expect(result.isError, command).toBe(true)
        expect(result.text, command).not.toContain("host-only-credential")
        expect(result.text, command).not.toContain(snapshot)
        expect(result.text, command).not.toContain("gitdir")
      }
      const listing = yield* bash(workspace, `ls -a ${REVIEW_WORKSPACE_ROOT}`)
      expect(listing.isError).toBe(false)
      expect(listing.text).not.toContain(".git")

      for (const target of [
        "/etc/passwd",
        "../outside-secret.txt",
        "escape-link",
        ".git",
        ".GIT",
      ]) {
        const result = yield* read(workspace, { path: target })
        expect(result.isError, target).toBe(true)
        expect(result.text, target).not.toContain("host-only-credential")
        expect(result.text, target).not.toContain(snapshot)
        expect(result.text, target).not.toContain("gitdir")
      }
      // `~` expands against the HOST home directory inside Pi's path
      // normalization before the overlay sees it; the error must not
      // disclose that host path.
      const tilde = yield* read(workspace, { path: "~/.ssh/config" })
      expect(tilde.isError).toBe(true)
      // @effect-diagnostics-next-line processEnvInEffect:off
      const hostHome = process.env["HOME"]
      if (hostHome !== undefined) {
        expect(tilde.text).not.toContain(hostHome)
      }

      // The host worktree's administrative entry is untouched.
      expect(yield* fs.exists(path.join(snapshot, ".git"))).toBe(true)
    }).pipe(Effect.scoped, Effect.provide(layer)))

  it.effect("exposes only the synthetic environment", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* makeSnapshotFixture
      const workspace = yield* Effect.promise(() =>
        makeReviewWorkspace(snapshot),
      )
      const env = yield* bash(workspace, "env")
      expect(env.isError).toBe(false)
      expect(env.text).toMatch(/^HOME=\//m)
      expect(env.text).toContain("HOSTNAME=localhost")
      expect(env.text).toContain("PWD=/repo")
      // @effect-diagnostics-next-line processEnvInEffect:off
      const hostHome = process.env["HOME"]
      if (hostHome !== undefined) {
        expect(env.text).not.toContain(hostHome)
      }
      // No host credential material: every visible value is synthetic, so
      // nothing from the parent process environment appears.
      const hostMarkers = ["ANTHROPIC", "AWS_", "GITHUB_TOKEN", "SSH_"]
      for (const marker of hostMarkers) {
        expect(env.text).not.toContain(marker)
      }
    }).pipe(Effect.scoped, Effect.provide(layer)))

  it.effect(
    "keeps writes invocation-local, visible to both tools, off the snapshot",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { snapshot } = yield* makeSnapshotFixture
        const first = yield* Effect.promise(() =>
          makeReviewWorkspace(snapshot),
        )
        const second = yield* Effect.promise(() =>
          makeReviewWorkspace(snapshot),
        )

        expect(
          (yield* bash(first, `echo "// patched" >> src/app.ts`)).isError,
        ).toBe(false)
        expect((yield* bash(first, "rm notes.md")).isError).toBe(false)

        // Both tools of the writing invocation observe the write...
        const viaBash = yield* bash(first, "cat src/app.ts")
        expect(viaBash.text).toContain("// patched")
        const viaRead = yield* read(first, { path: "src/app.ts" })
        expect(viaRead.text).toContain("// patched")
        expect((yield* bash(first, "cat notes.md")).isError).toBe(true)

        // ...while a sibling invocation over the same snapshot does not.
        const sibling = yield* bash(second, "cat src/app.ts")
        expect(sibling.text).not.toContain("// patched")
        expect((yield* bash(second, "cat notes.md")).isError).toBe(false)

        // The backing snapshot itself is untouched.
        expect(
          yield* fs.readFileString(path.join(snapshot, "src", "app.ts")),
        ).toBe(APP_SOURCE)
        expect(yield* fs.exists(path.join(snapshot, "notes.md"))).toBe(true)
      }).pipe(Effect.scoped, Effect.provide(layer)))

  it.effect("resets shell state per call while the filesystem persists", () =>
    Effect.gen(function* () {
      const { snapshot } = yield* makeSnapshotFixture
      const workspace = yield* Effect.promise(() =>
        makeReviewWorkspace(snapshot),
      )
      const stateful = yield* bash(
        workspace,
        `cd src && export MARKER=set && echo probe > /tmp-probe.txt && pwd`,
      )
      expect(stateful).toEqual({
        isError: false,
        text: `${REVIEW_WORKSPACE_ROOT}/src`,
      })
      expect(yield* bash(workspace, "pwd")).toEqual({
        isError: false,
        text: REVIEW_WORKSPACE_ROOT,
      })
      expect(yield* bash(workspace, `echo "\${MARKER:-unset}"`)).toEqual({
        isError: false,
        text: "unset",
      })
      expect(yield* bash(workspace, "cat /tmp-probe.txt")).toEqual({
        isError: false,
        text: "probe",
      })
    }).pipe(Effect.scoped, Effect.provide(layer)))

  it.effect(
    "turns every limit exhaustion into a tool error and leaves the snapshot alone",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem
        const path = yield* Path.Path
        const { snapshot } = yield* makeSnapshotFixture
        // Large enough for command registration (commands surface as
        // virtual /usr/bin entries in overlay memory), small enough for one
        // blob copy to exhaust.
        const workspace = yield* Effect.promise(() =>
          makeReviewWorkspace(snapshot, { maxOverlayMemoryBytes: 131_072 }),
        )

        const cases: ReadonlyArray<{
          readonly label: string
          readonly command: string
          readonly expects: RegExp
        }> = [
          {
            label: "captured output",
            command: "cat data/blob.txt",
            expects: /output size/i,
          },
          {
            label: "call depth",
            command: "recurse() { recurse; }; recurse",
            expects: /depth|recursion/i,
          },
          {
            label: "bash loop / command count",
            command: "while :; do :; done",
            expects: /limit|too many commands/i,
          },
          {
            label: "awk iterations",
            command: `awk 'BEGIN{while(1){}}'`,
            expects: /awk.*limit|iteration/i,
          },
          {
            label: "sed iterations",
            command: `echo x | sed ':a;ba'`,
            expects: /sed.*limit|iteration/i,
          },
          {
            label: "copy-on-write memory",
            command: "cp data/blob.txt scratch-copy.txt",
            expects: /memory|space|limit/i,
          },
        ]
        for (const { command, expects, label } of cases) {
          const result = yield* bash(workspace, command)
          expect(result.isError, label).toBe(true)
          expect(result.text, label).toMatch(expects)
          expect(result.text, label).not.toContain(snapshot)
        }

        // A timeout past Node's 2^31-1ms timer ceiling is rejected up front
        // instead of overflowing into an immediate abort.
        const overflow = yield* execBashTool(workspace.bashTool, {
          command: "pwd",
          timeout: 3_000_000,
        })
        expect(overflow.isError).toBe(true)
        expect(overflow.text).toContain("Invalid timeout")

        // A model-supplied timeout reports as a timeout even when the
        // interpreter honors the abort by resolving with exit code 124.
        const modelTimeout = yield* execBashTool(workspace.bashTool, {
          command: "sleep 5",
          timeout: 0.05,
        })
        expect(modelTimeout.isError).toBe(true)
        expect(modelTimeout.text).toContain("timed out after 0.05 seconds")

        // The tool deadline stays caller-owned and bounds a stuck command.
        const deadlined = withToolCallDeadline(workspace.bashTool, 200)
        const timedOut = yield* Effect.promise(() =>
          callOnSeam(deadlined, { command: "sleep 5" })
            .then(
              () => "resolved",
              (cause: unknown) =>
                cause instanceof Error ? cause.message : String(cause),
            ),
        )
        expect(timedOut).toContain("bash exceeded its 200ms deadline")

        // Nothing above mutated the backing snapshot.
        expect(
          yield* fs.readFileString(path.join(snapshot, "src", "app.ts")),
        ).toBe(APP_SOURCE)
        expect(
          yield* fs.exists(path.join(snapshot, "scratch-copy.txt")),
        ).toBe(false)
        const status = yield* runGit(snapshot, ["status", "--porcelain"])
        expect(status).toBe("")
      }).pipe(Effect.scoped, Effect.provide(layer)))
})
