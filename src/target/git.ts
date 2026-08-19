import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

export class GitCommandError extends Data.TaggedError("GitCommandError")<{
  readonly args: ReadonlyArray<string>
  readonly exitCode: number | undefined
  readonly stderr: string
  readonly cause: unknown
}> {}

// rev-parse and friends terminate with a single newline. Strip exactly that
// — trim() would also eat whitespace that is legally part of a path.
export const chompLine = (out: string) => out.replace(/\n$/, "")

// Gitlink entries in NUL-separated `ls-files --stage` or `ls-tree -r` output.
// Both formats lead with the mode and put the path after the first tab.
export const gitlinkPaths = (out: string): ReadonlyArray<string> =>
  out
    .split("\0")
    .filter((entry) => entry.startsWith("160000 "))
    .flatMap((entry) => {
      const tab = entry.indexOf("\t")
      return tab === -1 ? [] : [entry.slice(tab + 1)]
    })

// The review snapshot never materializes submodule contents — agents see an
// unpopulated gitlink directory, so the degraded scope must be named (#56).
export const submoduleWarning = (
  paths: ReadonlyArray<string>,
): ReadonlyArray<string> =>
  paths.length === 0 ? [] : [
    `${String(paths.length)} submodule(s) whose contents are not included in the review: ${
      paths.join(", ")
    }`,
  ]

export const describeGitFailure = (
  reason: string,
  cause: GitCommandError,
): string =>
  cause.exitCode === undefined
    ? `git could not run: ${String(cause.cause)}`
    : cause.stderr.trim() === ""
    ? reason
    : `${reason}: ${cause.stderr.trim()}`

// The repository is selected by cwd alone. Git hooks export GIT_DIR,
// GIT_WORK_TREE, and friends into the environment, and those silently
// OVERRIDE cwd — a review launched from a hook would target the hook's repo.
// Unset them for the child (same list as vitest.setup.ts guards for tests).
// Shared with gh (which shells out to git) and the git test fixture.
export const scrubbedGitEnv = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_PREFIX: undefined,
  GIT_QUARANTINE_PATH: undefined,
  GIT_WORK_TREE: undefined,
} satisfies Record<string, undefined>

// Runs one git command and captures stdout. A non-zero exit is a
// GitCommandError carrying git's own stderr — the caller decides what it
// means (not-a-repo and no-HEAD are "could not review", never defects).
// A spawn failure (git missing) is the same error with exitCode undefined.
export const runGit = Effect.fn("gauntlet.git.run_git")(
  function* (
    cwd: string,
    args: ReadonlyArray<string>,
    env: Record<string, string> = {},
  ) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("git", args, {
          cwd,
          env: { ...scrubbedGitEnv, ...env },
          extendEnv: true,
        })
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            Stream.decodeText(handle.stdout).pipe(Stream.mkString),
            Stream.decodeText(handle.stderr).pipe(Stream.mkString),
            handle.exitCode,
          ],
          { concurrency: 3 },
        )
        if (exitCode !== 0) {
          return yield* new GitCommandError({
            args,
            exitCode,
            stderr,
            cause: undefined,
          })
        }
        return stdout
      }),
    ).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(
          new GitCommandError({ args, exitCode: undefined, stderr: "", cause }),
        ),
      ),
    )
  },
)
