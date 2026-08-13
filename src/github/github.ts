import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly operation: "view" | "post"
  readonly reason: string
  readonly cause?: unknown
}> {}

// gh --json field names, decoded at the boundary. The resolver turns these
// OIDs into a frozen PullRequest range; delivery only needs cwd + number.
export const PullRequestView = Schema.Struct({
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  headRefOid: Schema.NonEmptyString,
  baseRefOid: Schema.NonEmptyString,
  baseRefName: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
})
export interface PullRequestView extends Schema.Schema.Type<typeof PullRequestView> {}

export interface PostedComment {
  readonly url: string
}

export interface GitHubShape {
  readonly viewPullRequest: (
    cwd: string,
    number: number,
  ) => Effect.Effect<PullRequestView, GitHubError>
  readonly postComment: (
    cwd: string,
    number: number,
    body: string,
  ) => Effect.Effect<PostedComment, GitHubError>
}

// The thin GitHub boundary (issue #25, spec #15): PR metadata and the single
// comment post. Tests replace this layer; nothing above talks to the network.
export class GitHub extends Context.Service<GitHub, GitHubShape>()(
  "gauntlet/GitHub",
) {}

export const gitHubLayer = (impl: GitHubShape) =>
  Layer.succeed(GitHub, GitHub.of(impl))

export const unusedGitHubLayer = gitHubLayer({
  viewPullRequest: () =>
    Effect.fail(
      new GitHubError({ operation: "view", reason: "GitHub not scripted" }),
    ),
  postComment: () =>
    Effect.fail(
      new GitHubError({ operation: "post", reason: "GitHub not scripted" }),
    ),
})

const decodeView = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestView))

// Same GIT_* scrub as runGit: gh shells out to git, and hook-exported GIT_DIR
// would silently retarget the repository.
const scrubbedGitEnv: Record<string, undefined> = {
  GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined,
  GIT_CEILING_DIRECTORIES: undefined,
  GIT_COMMON_DIR: undefined,
  GIT_DIR: undefined,
  GIT_INDEX_FILE: undefined,
  GIT_OBJECT_DIRECTORY: undefined,
  GIT_PREFIX: undefined,
  GIT_QUARANTINE_PATH: undefined,
  GIT_WORK_TREE: undefined,
}

const lastNonEmptyLine = (text: string): string => {
  const lines = text.split("\n").map((line) => line.trim()).filter((line) =>
    line !== ""
  )
  return lines[lines.length - 1] ?? ""
}

const runGh = (
  spawner: ChildProcessSpawner["Service"],
  cwd: string,
  args: ReadonlyArray<string>,
  operation: GitHubError["operation"],
) =>
  Effect.scoped(
    Effect.gen(function* () {
      const handle = yield* ChildProcess.make("gh", args, {
        cwd,
        env: scrubbedGitEnv,
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
        const detail = stderr.trim() === "" ? stdout.trim() : stderr.trim()
        return yield* new GitHubError({
          operation,
          reason: detail === ""
            ? `gh ${args.join(" ")} exited ${String(exitCode)}`
            : detail,
        })
      }
      return stdout
    }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner, spawner),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        new GitHubError({
          operation,
          reason: `gh could not run: ${String(cause)}`,
          cause,
        }),
      )),
  )

const makeLive = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner

  const viewPullRequest = Effect.fn("gauntlet.github.view_pull_request")(
    function* (cwd: string, number: number) {
      const stdout = yield* runGh(
        spawner,
        cwd,
        [
          "pr",
          "view",
          String(number),
          "--json",
          "number,headRefOid,baseRefOid,baseRefName,url",
        ],
        "view",
      )
      return yield* decodeView(stdout).pipe(
        Effect.mapError((cause) =>
          new GitHubError({
            operation: "view",
            reason: `gh pr view #${String(number)} returned an undecodable payload`,
            cause,
          })),
      )
    },
  )

  const postComment = Effect.fn("gauntlet.github.post_comment")(
    function* (cwd: string, number: number, body: string) {
      return yield* Effect.scoped(
        Effect.gen(function* () {
          const bodyFile = yield* fs.makeTempFileScoped()
          yield* fs.writeFileString(bodyFile, body)
          const stdout = yield* runGh(
            spawner,
            cwd,
            [
              "pr",
              "comment",
              String(number),
              "--body-file",
              bodyFile,
            ],
            "post",
          )
          const url = lastNonEmptyLine(stdout)
          if (url === "") {
            return yield* new GitHubError({
              operation: "post",
              reason: `gh pr comment #${String(number)} produced no comment URL`,
            })
          }
          return { url } satisfies PostedComment
        }),
      ).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            new GitHubError({
              operation: "post",
              reason: `could not stage comment body: ${String(cause)}`,
              cause,
            }),
          )),
      )
    },
  )

  return GitHub.of({ viewPullRequest, postComment })
})

export const liveGitHubLayer = Layer.effect(GitHub, makeLive)
