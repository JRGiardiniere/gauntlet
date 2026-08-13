import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { scrubbedGitEnv } from "../target/git.ts"

export class FixtureGitError extends Data.TaggedError("FixtureGitError")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number | undefined
  readonly stderr: string
}> {}

export interface GitFixture {
  readonly root: string
  readonly repo: string
}

// Same GIT_* override list as production runGit: hooks export these and
// they silently replace cwd. The fixture spawns git through ChildProcess
// directly, never the production wrapper.

const git = (cwd: string, args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("git", args, {
        cwd,
        env: scrubbedGitEnv,
        extendEnv: true,
      })
      const [, stderr, exitCode] = yield* Effect.all(
        [
          Stream.decodeText(handle.stdout).pipe(Stream.mkString),
          Stream.decodeText(handle.stderr).pipe(Stream.mkString),
          handle.exitCode,
        ],
        { concurrency: 3 },
      )
      if (exitCode !== 0) {
        return yield* new FixtureGitError({ args, exitCode, stderr })
      }
    }),
  )

export const commitAll = (repo: string, message: string) =>
  Effect.gen(function* () {
    yield* git(repo, ["add", "--all"])
    yield* git(repo, [
      "-c",
      "user.name=gauntlet-test",
      "-c",
      "user.email=gauntlet-test@example.invalid",
      "commit",
      "--message",
      message,
    ])
  })

// git resolves /var → /private/var on macOS; realpath keeps the frozen
// target's repoRoot equal to the fixture's own paths.
export const makeGitFixture = (options?: { readonly prefix?: string }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const temp = yield* fs.makeTempDirectoryScoped({
      prefix: options?.prefix ?? "gauntlet-git-test-",
    })
    const root = yield* fs.realPath(temp)
    const repo = path.join(root, "repo")
    yield* fs.makeDirectory(repo, { recursive: true })
    yield* git(repo, ["init"])
    return { root, repo } satisfies GitFixture
  })
