import * as Array from "effect/Array"
import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { pipe } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { scrubbedGitEnv } from "../target/git.ts"

export class GitHubError extends Schema.TaggedError<
  GitHubError,
  { readonly brand: unique symbol }
>()("GitHubError", {
  operation: Schema.Literals(["view", "post"]),
  reason: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

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

export interface GitHubContract {
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
export class GitHub extends Context.Service<GitHub, GitHubContract>()(
  "gauntlet/GitHub",
) {}

export const gitHubLayer = (impl: GitHubContract) =>
  Layer.succeed(GitHub, GitHub.of(impl))

const unused = (operation: GitHubError["operation"]) =>
  () =>
    Effect.fail(
      GitHubError.make({ operation, reason: "GitHub not scripted" }),
    )

export const unusedGitHubContract: GitHubContract = {
  viewPullRequest: unused("view"),
  postComment: unused("post"),
}

export const unusedGitHubLayer = gitHubLayer(unusedGitHubContract)

const decodeView = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestView))

const lastNonEmptyLine = (text: string): string => {
  const lines = pipe(
    text.split("\n"),
    Array.map((line) => line.trim()),
    Array.filter((line) => line !== ""),
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

        return yield* GitHubError.make({
          operation,
          reason: detail === ""
            ? `gh ${Array.join(args, " ")} exited ${String(exitCode)}`
            : detail,
        })
      }

      return stdout
    }),
  ).pipe(
    Effect.provideService(ChildProcessSpawner, spawner),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(
        GitHubError.make({
          operation,
          reason: cause.reason._tag === "NotFound" &&
              cause.reason.module === "ChildProcess"
            ? "gh is not installed — install the GitHub CLI (https://cli.github.com) and run `gh auth login`"
            : `gh could not run: ${String(cause)}`,
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
          GitHubError.make({
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
            return yield* GitHubError.make({
              operation: "post",
              reason: `gh pr comment #${String(number)} produced no comment URL`,
            })
          }

          return { url } satisfies PostedComment
        }),
      ).pipe(
        Effect.catchTag("PlatformError", (cause) =>
          Effect.fail(
            GitHubError.make({
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
