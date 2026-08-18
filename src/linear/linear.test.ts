import { describe, expect, it } from "@effect/vitest"
import * as ConfigProvider from "effect/ConfigProvider"
import * as Effect from "effect/Effect"
import type * as Schema from "effect/Schema"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { Linear } from "./linear.ts"

const jsonResponse = (body: Schema.Json, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    }),
  )

const issue = (
  id: string,
  identifier: string,
  title: string,
  description: string,
  state: string,
) => ({
  id,
  identifier,
  url: `https://linear.app/example/issue/${identifier}`,
  title,
  description,
  state: { name: state },
})

const pageInfo = { hasNextPage: false, endCursor: null }

describe("Linear.Default", () => {
  it.effect("decodes the branch issue, parent, siblings, and human/bot authors", () => {
    const requests: Array<string> = []
    const fakeFetch: typeof globalThis.fetch = (input, init) =>
      new Request(input, init).text().then((body) => {
        requests.push(body)
        if (body.includes("GauntletLinearIssue")) {
          return jsonResponse({
            data: {
              issue: {
                ...issue(
                  "slice-id",
                  "ENG-75",
                  "Linear source",
                  "slice body",
                  "In Progress",
                ),
                parent: issue(
                  "parent-id",
                  "ENG-70",
                  "Review specification",
                  "parent body",
                  "Todo",
                ),
              },
            },
          })
        }
        if (body.includes("GauntletLinearChildren")) {
          return jsonResponse({
            data: {
              issue: {
                children: {
                  nodes: [
                    issue(
                      "slice-id",
                      "ENG-75",
                      "Linear source",
                      "slice body",
                      "In Progress",
                    ),
                    issue(
                      "sibling-id",
                      "ENG-76",
                      "Conformance",
                      "sibling body",
                      "Done",
                    ),
                  ],
                  pageInfo,
                },
              },
            },
          })
        }
        const parent = body.includes("parent-id")
        return jsonResponse({
          data: {
            issue: {
              comments: {
                nodes: parent
                  ? [{
                      url: "https://linear.app/comment/parent-human",
                      body: "parent human",
                      createdAt: "2026-01-01T00:00:00Z",
                      botActor: null,
                      user: { id: "human-1" },
                    }]
                  : [
                      {
                        url: "https://linear.app/comment/slice-human",
                        body: "slice human",
                        createdAt: "2026-01-02T00:00:00Z",
                        botActor: null,
                        user: { id: "human-2" },
                      },
                      {
                        url: "https://linear.app/comment/linkback",
                        body: "linkback",
                        createdAt: "2026-01-03T00:00:00Z",
                        botActor: { id: "github-bot" },
                        user: null,
                      },
                    ],
                pageInfo,
              },
            },
          },
        })
      })
    return Effect.gen(function* () {
      const linear = yield* Linear
      const result = yield* linear.viewIssue("ENG-75")

      expect(result.identifier).toBe("ENG-75")
      expect(result.parent?.identifier).toBe("ENG-70")
      expect(result.siblings.map(({ identifier }) => identifier)).toEqual([
        "ENG-76",
      ])
      expect(result.parent?.comments.map(({ isBot }) => isBot)).toEqual([false])
      expect(result.comments.map(({ isBot }) => isBot)).toEqual([false, true])
      expect(requests).toHaveLength(4)
    }).pipe(
      Effect.provide(Linear.Default),
      Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ LINEAR_API_KEY: "test-key" }),
        ),
      ),
    )
  })

  it.effect("classifies missing and rejected API keys", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const error = yield* linear.viewIssue("ENG-75").pipe(Effect.flip)
      expect(error.reason).toBe("missing-api-key")
    }).pipe(
      Effect.provide(Linear.Default),
      Effect.provideService(
        FetchHttpClient.Fetch,
        () => jsonResponse({}, 401),
      ),
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({})),
      ),
    ))

  it.effect("classifies an HTTP authorization rejection", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const error = yield* linear.viewIssue("ENG-75").pipe(Effect.flip)
      expect(error.reason).toBe("invalid-api-key")
    }).pipe(
      Effect.provide(Linear.Default),
      Effect.provideService(
        FetchHttpClient.Fetch,
        () => jsonResponse({}, 401),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ LINEAR_API_KEY: "bad-key" }),
        ),
      ),
    ))

  it.effect("classifies denied workspace access separately from a bad key", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const error = yield* linear.viewIssue("ENG-75").pipe(Effect.flip)
      expect(error.reason).toBe("unresolvable-issue")
      expect(error.detail).toContain("HTTP 403")
    }).pipe(
      Effect.provide(Linear.Default),
      Effect.provideService(
        FetchHttpClient.Fetch,
        () => jsonResponse({}, 403),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ LINEAR_API_KEY: "valid-other-workspace" }),
        ),
      ),
    ))

  it.effect("classifies GraphQL issue-not-found errors as unresolvable", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const error = yield* linear.viewIssue("ENG-404").pipe(Effect.flip)
      expect(error.reason).toBe("unresolvable-issue")
      expect(error.detail).toContain("Issue not found")
    }).pipe(
      Effect.provide(Linear.Default),
      Effect.provideService(
        FetchHttpClient.Fetch,
        () =>
          jsonResponse({
            data: { issue: null },
            errors: [{
              message: "Issue not found",
              extensions: { code: "ENTITY_NOT_FOUND" },
            }],
          }),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ LINEAR_API_KEY: "test-key" }),
        ),
      ),
    ))

  it.effect("rejects an oversized response before JSON decoding", () =>
    Effect.gen(function* () {
      const linear = yield* Linear
      const error = yield* linear.viewIssue("ENG-75").pipe(Effect.flip)
      expect(error.reason).toBe("invalid-response")
      expect(error.detail).toContain("exceeded 5242880 bytes")
    }).pipe(
      Effect.provide(Linear.Default),
      Effect.provideService(
        FetchHttpClient.Fetch,
        () => Promise.resolve(new Response("x".repeat(5 * 1024 * 1024 + 1))),
      ),
      Effect.provide(
        ConfigProvider.layer(
          ConfigProvider.fromUnknown({ LINEAR_API_KEY: "test-key" }),
        ),
      ),
    ))
})
