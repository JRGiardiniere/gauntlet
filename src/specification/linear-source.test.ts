import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  LinearError,
  Linear,
  type LinearBranchIssue,
  type LinearCommentSnapshot,
  type LinearIssueSnapshot,
} from "../linear/linear.ts"
import {
  LinearSpecificationResolution,
  linearIssueIdentifierFromBranch,
  loadLinearSpecification,
  reviewSpecificationFromLinearIssue,
} from "./linear-source.ts"

const issue = (
  identifier: string,
  title: string,
  body: string,
  state: string,
  comments: ReadonlyArray<LinearCommentSnapshot> = [],
): LinearIssueSnapshot => ({
  id: `id-${identifier}`,
  identifier,
  url: `https://linear.app/example/issue/${identifier}`,
  title,
  body,
  state,
  comments,
})

const comment = (
  body: string,
  createdAt: string,
  isBot = false,
): LinearCommentSnapshot => ({
  url: `https://linear.app/example/comment/${body}`,
  body,
  createdAt,
  isBot,
})

const branchIssue = (): LinearBranchIssue => ({
  ...issue(
    "ENG-75",
    "Linear source",
    "SLICE-BODY",
    "In Progress",
    [
      comment("newer human", "2026-01-03T00:00:00Z"),
      comment("linkback bot", "2026-01-02T00:00:00Z", true),
    ],
  ),
  parent: issue(
    "ENG-70",
    "Review specification",
    "PARENT-BODY",
    "Todo",
    [comment("older human", "2026-01-01T00:00:00Z")],
  ),
  siblings: [
    issue("ENG-76", "Conformance", "UNFETCHED-SIBLING-BODY", "Done"),
    issue("ENG-74", "GitHub source", "UNFETCHED-SIBLING-BODY", "Canceled"),
  ],
})

describe("linearIssueIdentifierFromBranch", () => {
  it("reads one issue identifier anywhere in a Linear-style branch name", () => {
    expect(linearIssueIdentifierFromBranch("john/eng-75-linear-source")).toBe(
      "ENG-75",
    )
    expect(linearIssueIdentifierFromBranch("feature/ENG-75/source")).toBe(
      "ENG-75",
    )
  })

  it("rejects non-identifiers and ambiguous multi-issue branches", () => {
    expect(linearIssueIdentifierFromBranch("feature/eng75-linear-source")).toBeUndefined()
    expect(
      linearIssueIdentifierFromBranch("agent/issue-75-linear-source"),
    ).toBeUndefined()
    expect(
      linearIssueIdentifierFromBranch("feature/ENG-75-and-OPS-9"),
    ).toBeUndefined()
  })
})

describe("reviewSpecificationFromLinearIssue", () => {
  it("uses the Slice, parent, sibling titles and states, and chronological human comments", () => {
    const specification = reviewSpecificationFromLinearIssue(branchIssue())

    expect(
      specification.documents.map((document) => ({
        role: document.role,
        title: document.title,
        state: document.state,
        text: document.text,
      })),
    ).toEqual([
      {
        role: "parent",
        title: "Review specification",
        state: "Todo",
        text: "PARENT-BODY",
      },
      {
        role: "slice",
        title: "Linear source",
        state: "In Progress",
        text: "SLICE-BODY",
      },
      {
        role: "sibling",
        title: "GitHub source",
        state: "Canceled",
        text: "",
      },
      {
        role: "sibling",
        title: "Conformance",
        state: "Done",
        text: "",
      },
    ])
    expect(specification.comments.map(({ text }) => text)).toEqual([
      "older human",
      "newer human",
    ])
  })
})

describe("loadLinearSpecification", () => {
  it.effect("resolves only the branch-bound identifier through a fake Linear service", () =>
    Effect.gen(function* () {
      const requested: Array<string> = []
      const resolution = yield* loadLinearSpecification(
        "john/eng-75-linear-source",
      ).pipe(
        Effect.provide(
          Linear.Fake({
            viewIssue: (identifier) => {
              requested.push(identifier)
              return Effect.succeed(branchIssue())
            },
          }),
        ),
      )

      expect(requested).toEqual(["ENG-75"])
      expect(LinearSpecificationResolution.$is("Resolved")(resolution)).toBe(
        true,
      )
    }))

  it.effect("keeps a matching branch's missing key distinct from quiet absence", () =>
    Effect.gen(function* () {
      const resolution = yield* loadLinearSpecification(
        "john/eng-75-linear-source",
      ).pipe(
        Effect.provide(
          Linear.Fake({
            viewIssue: () =>
              Effect.fail(
                new LinearError({
                  reason: "missing-api-key",
                  detail: "LINEAR_API_KEY is not set",
                }),
              ),
          }),
        ),
      )

      expect(LinearSpecificationResolution.$is("Unreachable")(resolution)).toBe(
        true,
      )
      if (LinearSpecificationResolution.$is("Unreachable")(resolution)) {
        expect(resolution.diagnostic.reason).toBe("missing-api-key")
        expect(resolution.diagnostic.message).toContain("Set it and rerun")
      }
    }))
})
