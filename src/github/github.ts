import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { scrubbedGitEnv } from "../target/git.ts"

export class GitHubError extends Data.TaggedError("GitHubError")<{
  readonly operation: "view" | "post" | "specification"
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

export interface GitHubIssueComment {
  readonly url: string
  readonly body: string
  readonly createdAt: string
  readonly authorAssociation: string
}

export interface GitHubIssueSnapshot {
  readonly number: number
  readonly url: string
  readonly title: string
  readonly body: string
  readonly state: "OPEN" | "CLOSED"
  readonly comments: ReadonlyArray<GitHubIssueComment>
}

export interface GitHubClosingIssue extends GitHubIssueSnapshot {
  readonly parent: GitHubIssueSnapshot | undefined
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
  readonly viewClosingIssues: (
    cwd: string,
    number: number,
  ) => Effect.Effect<ReadonlyArray<GitHubClosingIssue>, GitHubError>
}

// The thin GitHub boundary (issue #25, spec #15, issue #74): PR metadata,
// the single comment post, and closing-issue snapshots for the GitHub
// Specification Source. Tests replace this layer; nothing above talks to
// the network.
export class GitHub extends Context.Service<GitHub, GitHubContract>()(
  "gauntlet/GitHub",
) {}

export const gitHubLayer = (impl: GitHubContract) =>
  Layer.succeed(GitHub, GitHub.of(impl))

const unused = (operation: GitHubError["operation"]) =>
  () =>
    Effect.fail(
      new GitHubError({ operation, reason: "GitHub not scripted" }),
    )

export const unusedGitHubContract: GitHubContract = {
  viewPullRequest: unused("view"),
  postComment: unused("post"),
  viewClosingIssues: unused("specification"),
}

export const unusedGitHubLayer = gitHubLayer(unusedGitHubContract)

const decodeView = Schema.decodeUnknownEffect(Schema.fromJsonString(PullRequestView))

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

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
})

const WireComment = Schema.Struct({
  url: Schema.NonEmptyString,
  body: Schema.NullOr(Schema.String),
  createdAt: Schema.NonEmptyString,
  authorAssociation: Schema.String,
})

const CommentConnection = Schema.Struct({
  pageInfo: PageInfo,
  nodes: Schema.Array(WireComment),
})

const WireIssue = Schema.Struct({
  id: Schema.NonEmptyString,
  number: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  url: Schema.NonEmptyString,
  title: Schema.String,
  body: Schema.NullOr(Schema.String),
  state: Schema.Literals(["OPEN", "CLOSED"]),
  comments: CommentConnection,
})
type WireIssue = typeof WireIssue.Type

const WireClosingIssue = WireIssue.pipe(
  Schema.fieldsAssign({
    parent: Schema.NullOr(WireIssue),
  }),
)
type WireClosingIssue = typeof WireClosingIssue.Type

const ClosingIssuesEnvelope = Schema.Struct({
  data: Schema.Struct({
    repository: Schema.NullOr(Schema.Struct({
      pullRequest: Schema.NullOr(Schema.Struct({
        closingIssuesReferences: Schema.Struct({
          pageInfo: PageInfo,
          nodes: Schema.Array(WireClosingIssue),
        }),
      })),
    })),
  }),
})

const NodeCommentsEnvelope = Schema.Struct({
  data: Schema.Struct({
    node: Schema.NullOr(Schema.Struct({
      comments: CommentConnection,
    })),
  }),
})

const decodeClosingIssues = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ClosingIssuesEnvelope),
)
const decodeNodeComments = Schema.decodeUnknownEffect(
  Schema.fromJsonString(NodeCommentsEnvelope),
)

const ISSUE_FIELDS = `
  id
  number
  url
  title
  body
  state
  comments(first: 100) {
    pageInfo { hasNextPage endCursor }
    nodes { url body createdAt authorAssociation }
  }
`

const CLOSING_ISSUES_QUERY = `
query ClosingIssues($owner: String!, $repo: String!, $number: Int!, $after: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      closingIssuesReferences(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${ISSUE_FIELDS}
          parent {
            ${ISSUE_FIELDS}
          }
        }
      }
    }
  }
}
`

const ISSUE_COMMENTS_QUERY = `
query IssueComments($id: ID!, $after: String!) {
  node(id: $id) {
    ... on Issue {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes { url body createdAt authorAssociation }
      }
    }
  }
}
`

const flattenComment = (
  comment: typeof WireComment.Type,
): GitHubIssueComment => ({
  url: comment.url,
  body: comment.body ?? "",
  createdAt: comment.createdAt,
  authorAssociation: comment.authorAssociation,
})

const flattenIssue = (
  issue: WireIssue,
  comments: ReadonlyArray<GitHubIssueComment>,
): GitHubIssueSnapshot => ({
  number: issue.number,
  url: issue.url,
  title: issue.title,
  body: issue.body ?? "",
  state: issue.state,
  comments,
})

const graphqlUndecodable = (cause: unknown) =>
  new GitHubError({
    operation: "specification",
    reason: "GitHub GraphQL returned an undecodable specification payload",
    cause,
  })

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

  const runGraphql = (
    cwd: string,
    query: string,
    fields: ReadonlyArray<readonly [flag: "-f" | "-F", name: string, value: string]>,
  ) =>
    runGh(
      spawner,
      cwd,
      [
        "api",
        "graphql",
        "-f",
        `query=${query}`,
        ...fields.flatMap(([flag, name, value]) => [flag, `${name}=${value}`]),
      ],
      "specification",
    )

  const remainingComments = Effect.fn("gauntlet.github.remaining_issue_comments")(
    function* (cwd: string, issueId: string, page: typeof CommentConnection.Type) {
      const comments = page.nodes.map(flattenComment)
      let hasNextPage = page.pageInfo.hasNextPage
      let cursor = page.pageInfo.endCursor
      const collected: Array<GitHubIssueComment> = [...comments]
      while (hasNextPage && cursor !== null) {
        const stdout = yield* runGraphql(cwd, ISSUE_COMMENTS_QUERY, [
          ["-F", "id", issueId],
          ["-f", "after", cursor],
        ])
        const envelope = yield* decodeNodeComments(stdout).pipe(
          Effect.mapError(graphqlUndecodable),
        )
        const connection = envelope.data.node?.comments
        if (connection === undefined) {
          return yield* new GitHubError({
            operation: "specification",
            reason: "GitHub GraphQL comment page was missing",
          })
        }
        collected.push(...connection.nodes.map(flattenComment))
        hasNextPage = connection.pageInfo.hasNextPage
        cursor = connection.pageInfo.endCursor
      }
      return collected
    },
  )

  const completeIssue = Effect.fn("gauntlet.github.complete_issue")(
    function* (cwd: string, issue: WireIssue) {
      const comments = yield* remainingComments(cwd, issue.id, issue.comments)
      return flattenIssue(issue, comments)
    },
  )

  const viewClosingIssues = Effect.fn("gauntlet.github.view_closing_issues")(
    function* (cwd: string, number: number) {
      const collected: Array<WireClosingIssue> = []
      let after: string | null = null
      let hasNextPage = true
      while (hasNextPage) {
        const fields: Array<readonly [flag: "-f" | "-F", name: string, value: string]> = [
          ["-F", "owner", "{owner}"],
          ["-F", "repo", "{repo}"],
          ["-F", "number", String(number)],
        ]
        if (after !== null) {
          fields.push(["-f", "after", after])
        }
        const stdout = yield* runGraphql(cwd, CLOSING_ISSUES_QUERY, fields)
        const envelope = yield* decodeClosingIssues(stdout).pipe(
          Effect.mapError(graphqlUndecodable),
        )
        const pullRequest = envelope.data.repository?.pullRequest
        if (pullRequest === undefined || pullRequest === null) {
          return yield* new GitHubError({
            operation: "specification",
            reason: `GitHub GraphQL returned no pull request #${String(number)}`,
          })
        }
        collected.push(...pullRequest.closingIssuesReferences.nodes)
        hasNextPage = pullRequest.closingIssuesReferences.pageInfo.hasNextPage
        after = pullRequest.closingIssuesReferences.pageInfo.endCursor
        if (hasNextPage && after === null) break
      }

      const uniqueIssues = new Map<string, WireIssue>()
      for (const issue of collected) {
        uniqueIssues.set(issue.id, issue)
        if (issue.parent !== null) uniqueIssues.set(issue.parent.id, issue.parent)
      }
      const completed = new Map(
        yield* Effect.all(
          [...uniqueIssues.entries()].map(([id, issue]) =>
            completeIssue(cwd, issue).pipe(
              Effect.map((snapshot) => [id, snapshot] as const),
            )),
          { concurrency: 2 },
        ),
      )
      return collected.flatMap((issue) => {
        const snapshot = completed.get(issue.id)
        if (snapshot === undefined) return []
        const parent = issue.parent === null
          ? undefined
          : completed.get(issue.parent.id)
        return [{ ...snapshot, parent } satisfies GitHubClosingIssue]
      })
    },
  )

  return GitHub.of({ viewPullRequest, postComment, viewClosingIssues })
})

export const liveGitHubLayer = Layer.effect(GitHub, makeLive)
