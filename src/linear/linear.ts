import * as Config from "effect/Config"
import * as Context from "effect/Context"
import * as Data from "effect/Data"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as Redacted from "effect/Redacted"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest"
import type * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"

export type LinearErrorReason =
  | "invalid-api-key"
  | "invalid-response"
  | "missing-api-key"
  | "unreachable"
  | "unresolvable-issue"

export class LinearError extends Data.TaggedError("LinearError")<{
  readonly reason: LinearErrorReason
  readonly detail: string
  readonly cause?: unknown
}> {}

export interface LinearCommentSnapshot {
  readonly url: string
  readonly body: string
  readonly createdAt: string
  readonly isBot: boolean
}

export interface LinearIssueSnapshot {
  readonly id: string
  readonly identifier: string
  readonly url: string
  readonly title: string
  readonly body: string
  readonly state: string
  readonly comments: ReadonlyArray<LinearCommentSnapshot>
}

export interface LinearBranchIssue extends LinearIssueSnapshot {
  readonly parent: LinearIssueSnapshot | undefined
  readonly siblings: ReadonlyArray<LinearIssueSnapshot>
}

export interface LinearContract {
  readonly viewIssue: (
    identifier: string,
  ) => Effect.Effect<LinearBranchIssue, LinearError>
}

const PageInfo = Schema.Struct({
  hasNextPage: Schema.Boolean,
  endCursor: Schema.NullOr(Schema.String),
})

const WireIssueSummary = Schema.Struct({
  id: Schema.NonEmptyString,
  identifier: Schema.NonEmptyString,
  url: Schema.NonEmptyString,
  title: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: Schema.Struct({ name: Schema.NonEmptyString }),
})
type WireIssueSummary = typeof WireIssueSummary.Type

const WireComment = Schema.Struct({
  url: Schema.NonEmptyString,
  body: Schema.String,
  createdAt: Schema.NonEmptyString,
  botActor: Schema.NullOr(Schema.Struct({ id: Schema.NonEmptyString })),
  user: Schema.NullOr(Schema.Struct({ id: Schema.NonEmptyString })),
})

const CommentConnection = Schema.Struct({
  nodes: Schema.Array(WireComment),
  pageInfo: PageInfo,
})

const IssueConnection = Schema.Struct({
  nodes: Schema.Array(WireIssueSummary),
  pageInfo: PageInfo,
})

const GraphQlError = Schema.Struct({
  message: Schema.String,
  extensions: Schema.optionalKey(
    Schema.Struct({ code: Schema.optionalKey(Schema.String) }),
  ),
})

const IssueEnvelope = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({
      issue: Schema.NullOr(
        WireIssueSummary.pipe(
          Schema.fieldsAssign({ parent: Schema.NullOr(WireIssueSummary) }),
        ),
      ),
    })),
  ),
  errors: Schema.optionalKey(Schema.Array(GraphQlError)),
})

const CommentsEnvelope = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({
      issue: Schema.NullOr(Schema.Struct({ comments: CommentConnection })),
    })),
  ),
  errors: Schema.optionalKey(Schema.Array(GraphQlError)),
})

const ChildrenEnvelope = Schema.Struct({
  data: Schema.optionalKey(
    Schema.NullOr(Schema.Struct({
      issue: Schema.NullOr(Schema.Struct({ children: IssueConnection })),
    })),
  ),
  errors: Schema.optionalKey(Schema.Array(GraphQlError)),
})

const decodeIssueEnvelope = Schema.decodeUnknownEffect(IssueEnvelope)
const decodeCommentsEnvelope = Schema.decodeUnknownEffect(CommentsEnvelope)
const decodeChildrenEnvelope = Schema.decodeUnknownEffect(ChildrenEnvelope)

const ISSUE_QUERY = `
query GauntletLinearIssue($id: String!) {
  issue(id: $id) {
    id identifier url title description state { name }
    parent { id identifier url title description state { name } }
  }
}
`

const COMMENTS_QUERY = `
query GauntletLinearComments($id: String!, $after: String) {
  issue(id: $id) {
    comments(first: 100, after: $after) {
      nodes { url body createdAt botActor { id } user { id } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
`

const CHILDREN_QUERY = `
query GauntletLinearChildren($id: String!, $after: String) {
  issue(id: $id) {
    children(first: 100, after: $after) {
      nodes { id identifier url title description state { name } }
      pageInfo { hasNextPage endCursor }
    }
  }
}
`

const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql"
const MAX_CONNECTION_PAGES = 100
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024

interface ConnectionPage<A> {
  readonly nodes: ReadonlyArray<A>
  readonly pageInfo: typeof PageInfo.Type
}

interface CollectedBody {
  readonly chunks: Array<Uint8Array>
  readonly bytes: number
}

class ResponseBodyTooLarge extends Data.TaggedError("ResponseBodyTooLarge")<{
  readonly bytes: number
}> {}

const invalidResponse = (detail: string, cause?: unknown) =>
  cause === undefined
    ? new LinearError({ reason: "invalid-response", detail })
    : new LinearError({ reason: "invalid-response", detail, cause })

const decodeJsonText = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Json),
)

const checkGraphQlErrors = (
  errors: ReadonlyArray<typeof GraphQlError.Type> | undefined,
): Effect.Effect<void, LinearError> => {
  if (errors === undefined || errors.length === 0) return Effect.void
  const detail = errors.map((error) => error.message).join("; ")
  const invalidKey = errors.some((error) =>
    error.extensions?.code === "AUTHENTICATION_ERROR" ||
    /api key|authenticat|unauthoriz/i.test(error.message)
  )
  const unresolvableIssue = errors.some((error) =>
    error.extensions?.code === "ENTITY_NOT_FOUND" ||
    /issue.*not found|not found.*issue/i.test(error.message)
  )
  return Effect.fail(
    new LinearError({
      reason: invalidKey
        ? "invalid-api-key"
        : unresolvableIssue
          ? "unresolvable-issue"
          : "unreachable",
      detail,
    }),
  )
}

const flattenIssue = (
  issue: WireIssueSummary,
  comments: ReadonlyArray<LinearCommentSnapshot> = [],
): LinearIssueSnapshot => ({
  id: issue.id,
  identifier: issue.identifier,
  url: issue.url,
  title: issue.title,
  body: issue.description ?? "",
  state: issue.state.name,
  comments,
})

const makeLive = Effect.gen(function* () {
  const apiKey = yield* Config.option(Config.redacted("LINEAR_API_KEY"))
  const client = (yield* HttpClient.HttpClient).pipe(
    HttpClient.transformResponse((attempt) =>
      attempt.pipe(Effect.timeout("15 seconds"))
    ),
    HttpClient.retryTransient({ times: 2 }),
  )

  const readBoundedJson = Effect.fn("gauntlet.linear.read_bounded_json")(
    function* (response: HttpClientResponse.HttpClientResponse) {
      const body = yield* Stream.runFoldEffect(
        response.stream,
        (): CollectedBody => ({ chunks: [], bytes: 0 }),
        (accumulator, chunk) => {
          const bytes = accumulator.bytes + chunk.byteLength
          if (bytes > MAX_RESPONSE_BYTES) {
            return Effect.fail(new ResponseBodyTooLarge({ bytes }))
          }
          accumulator.chunks.push(chunk)
          return Effect.succeed({ chunks: accumulator.chunks, bytes })
        },
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof ResponseBodyTooLarge
            ? invalidResponse(
                `Linear response exceeded ${String(MAX_RESPONSE_BYTES)} bytes`,
              )
            : invalidResponse("could not read the Linear response body", cause)
        ),
      )
      const bytes = new Uint8Array(body.bytes)
      let offset = 0
      for (const chunk of body.chunks) {
        bytes.set(chunk, offset)
        offset += chunk.byteLength
      }
      const text = new TextDecoder().decode(bytes)
      return yield* decodeJsonText(text).pipe(
        Effect.mapError((cause) =>
          invalidResponse("Linear returned invalid JSON", cause)
        ),
      )
    },
  )

  const graphql = Effect.fn("gauntlet.linear.graphql")(function* (
    query: string,
    variables: Readonly<Record<string, string | null>>,
  ) {
    if (Option.isNone(apiKey)) {
      return yield* new LinearError({
        reason: "missing-api-key",
        detail: "LINEAR_API_KEY is not set",
      })
    }
    const request = yield* HttpClientRequest.post(LINEAR_GRAPHQL_URL).pipe(
      HttpClientRequest.acceptJson,
      HttpClientRequest.setHeader(
        "Authorization",
        Redacted.value(apiKey.value),
      ),
      HttpClientRequest.bodyJson({ query, variables }),
      Effect.mapError((cause) =>
        invalidResponse("could not encode the Linear GraphQL request", cause)
      ),
    )
    const response = yield* client.execute(request).pipe(
      Effect.mapError((cause) =>
        new LinearError({
          reason: "unreachable",
          detail: "Linear could not be reached",
          cause,
        })
      ),
    )
    if (response.status === 401) {
      return yield* new LinearError({
        reason: "invalid-api-key",
        detail: `Linear rejected the API key with HTTP ${String(response.status)}`,
      })
    }
    if (response.status === 403) {
      return yield* new LinearError({
        reason: "unresolvable-issue",
        detail: "Linear denied access to the issue with HTTP 403",
      })
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new LinearError({
        reason: response.status >= 500 || response.status === 429
          ? "unreachable"
          : "invalid-response",
        detail: `Linear returned HTTP ${String(response.status)}`,
      })
    }
    return yield* readBoundedJson(response).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            new LinearError({
              reason: "unreachable",
              detail: "reading the Linear response body timed out",
            }),
          ),
      }),
    )
  })

  const collectConnection = <A>(
    noun: string,
    load: (
      after: string | null,
    ) => Effect.Effect<ConnectionPage<A>, LinearError>,
  ): Effect.Effect<ReadonlyArray<A>, LinearError> =>
    Effect.gen(function* () {
      const nodes: Array<A> = []
      let after: string | null = null
      for (let page = 0; page < MAX_CONNECTION_PAGES; page += 1) {
        const connection: ConnectionPage<A> = yield* load(after)
        nodes.push(...connection.nodes)
        if (!connection.pageInfo.hasNextPage) return nodes
        if (connection.pageInfo.endCursor === null) {
          return yield* invalidResponse(
            `Linear ${noun} page had no next cursor`,
          )
        }
        after = connection.pageInfo.endCursor
      }
      return yield* invalidResponse(
        `Linear ${noun} exceeded ${String(MAX_CONNECTION_PAGES)} pages`,
      )
    })

  const commentsFor = Effect.fn("gauntlet.linear.comments_for")(function* (
    issueId: string,
  ) {
    const comments = yield* collectConnection(
      "comments",
      (after) =>
        Effect.gen(function* () {
          const envelope: typeof CommentsEnvelope.Type = yield* graphql(
            COMMENTS_QUERY,
            { id: issueId, after },
          ).pipe(
            Effect.flatMap((json) => decodeCommentsEnvelope(json)),
            Effect.catchTag("SchemaError", (cause) =>
              Effect.fail(
                invalidResponse("Linear returned undecodable comments", cause),
              )
            ),
          )
          yield* checkGraphQlErrors(envelope.errors)
          const connection = envelope.data?.issue?.comments
          return connection === undefined
            ? yield* invalidResponse("Linear comment page was missing")
            : connection
        }),
    )
    return comments.map((comment) => ({
        url: comment.url,
        body: comment.body,
        createdAt: comment.createdAt,
        isBot: comment.botActor !== null || comment.user === null,
      }))
  })

  const childrenFor = Effect.fn("gauntlet.linear.children_for")(function* (
    issueId: string,
  ) {
    return yield* collectConnection(
      "siblings",
      (after) =>
        Effect.gen(function* () {
          const envelope: typeof ChildrenEnvelope.Type = yield* graphql(
            CHILDREN_QUERY,
            { id: issueId, after },
          ).pipe(
            Effect.flatMap((json) => decodeChildrenEnvelope(json)),
            Effect.catchTag("SchemaError", (cause) =>
              Effect.fail(
                invalidResponse("Linear returned undecodable siblings", cause),
              )
            ),
          )
          yield* checkGraphQlErrors(envelope.errors)
          const connection = envelope.data?.issue?.children
          return connection === undefined
            ? yield* invalidResponse("Linear sibling page was missing")
            : connection
        }),
    )
  })

  const viewIssue = Effect.fn("gauntlet.linear.view_issue")(function* (
    identifier: string,
  ) {
    const envelope = yield* graphql(ISSUE_QUERY, { id: identifier }).pipe(
      Effect.flatMap((json) => decodeIssueEnvelope(json)),
      Effect.catchTag("SchemaError", (cause) =>
        Effect.fail(
          invalidResponse("Linear returned an undecodable issue", cause),
        )
      ),
    )
    yield* checkGraphQlErrors(envelope.errors)
    const issue = envelope.data?.issue
    if (issue === undefined || issue === null) {
      return yield* new LinearError({
        reason: "unresolvable-issue",
        detail: `Linear issue ${identifier} was not found`,
      })
    }
    const parent = issue.parent
    const [sliceComments, parentComments, children] = yield* Effect.all(
      [
        commentsFor(issue.id),
        parent === null ? Effect.succeed([]) : commentsFor(parent.id),
        parent === null ? Effect.succeed([]) : childrenFor(parent.id),
      ],
      { concurrency: 3 },
    )
    return {
      ...flattenIssue(issue, sliceComments),
      parent: parent === null ? undefined : flattenIssue(parent, parentComments),
      siblings: children
        .filter((child) => child.id !== issue.id)
        .map((child) => flattenIssue(child)),
    } satisfies LinearBranchIssue
  })

  return { viewIssue } satisfies LinearContract
})

export class Linear extends Context.Service<Linear, LinearContract>()(
  "gauntlet/Linear",
) {
  static Default = Layer.effect(Linear, makeLive).pipe(
    Layer.provide(FetchHttpClient.layer),
  )

  static Fake = (impl: LinearContract) =>
    Layer.succeed(Linear, Linear.of(impl))
}

export const unusedLinearContract: LinearContract = {
  viewIssue: () =>
    Effect.fail(
      new LinearError({
        reason: "unreachable",
        detail: "Linear not scripted",
      }),
    ),
}

export const unusedLinearLayer = Linear.Fake(unusedLinearContract)
