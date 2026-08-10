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

// Runs one git command and captures stdout. A non-zero exit is a
// GitCommandError carrying git's own stderr — the caller decides what it
// means (not-a-repo and no-HEAD are "could not review", never defects).
export const runGit = Effect.fn("gauntlet.git.run_git")(
  function* (cwd: string, args: ReadonlyArray<string>) {
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* ChildProcess.make("git", args, { cwd })
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
