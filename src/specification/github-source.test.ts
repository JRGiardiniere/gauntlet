import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import {
  GitHubError,
  gitHubLayer,
  unusedGitHubContract,
  type GitHubClosingIssue,
  type GitHubIssueComment,
  type GitHubIssueSnapshot,
} from "../github/github.ts"
import {
  loadGitHubSpecification,
  reviewSpecificationFromGitHubIssues,
} from "./github-source.ts"

const issueUrl = (number: number) =>
  `https://github.com/example/repo/issues/${String(number)}`

const comment = (
  association: string,
  createdAt: string,
  body: string,
  number = 1,
): GitHubIssueComment => ({
  url: `${issueUrl(number)}#issuecomment-${createdAt}`,
  body,
  createdAt,
  authorAssociation: association,
})

const snapshot = (
  number: number,
  title: string,
  body: string,
  comments: ReadonlyArray<GitHubIssueComment> = [],
): GitHubIssueSnapshot => ({
  number,
  url: issueUrl(number),
  title,
  body,
  state: "OPEN",
  comments,
})

const closing = (
  issue: GitHubIssueSnapshot,
  parent: GitHubIssueSnapshot | undefined = undefined,
): GitHubClosingIssue => ({ ...issue, parent })

describe("reviewSpecificationFromGitHubIssues", () => {
  it("treats closing issues as Slices and follows one native parent, deduplicated", () => {
    const parent = snapshot(70, "parent spec", "parent body")
    const spec = reviewSpecificationFromGitHubIssues([
      closing(snapshot(74, "github source", "slice 74"), parent),
      closing(snapshot(75, "linear source", "slice 75"), parent),
    ])

    expect(spec?.documents.map((document) => [document.role, document.provenance, document.text])).toEqual([
      ["parent", issueUrl(70), "parent body"],
      ["slice", issueUrl(74), "slice 74"],
      ["slice", issueUrl(75), "slice 75"],
    ])
  })

  it("treats a Slice without a parent as a complete ReviewSpecification", () => {
    const spec = reviewSpecificationFromGitHubIssues([
      closing(snapshot(74, "standalone", "slice only")),
    ])
    expect(spec?.documents).toEqual([
      {
        role: "slice",
        provenance: issueUrl(74),
        text: "slice only",
        title: "standalone",
        state: "OPEN",
      },
    ])
    expect(spec?.comments).toEqual([])
    expect(spec?.commentOmission).toBeUndefined()
  })

  it("does not parse or follow ## Parent body text", () => {
    const native = snapshot(70, "native parent", "native body")
    const spec = reviewSpecificationFromGitHubIssues([
      closing(
        snapshot(74, "slice", "## Parent\n\n#999\n\nFollow this heading."),
        native,
      ),
    ])
    expect(spec?.documents.map((document) => document.provenance)).toEqual([
      issueUrl(70),
      issueUrl(74),
    ])
  })

  it("does not list a closing issue again as parent material", () => {
    const parentSlice = snapshot(70, "also a slice", "parent and slice")
    const spec = reviewSpecificationFromGitHubIssues([
      closing(parentSlice),
      closing(snapshot(74, "child", "child body"), parentSlice),
    ])
    expect(spec?.documents.map((document) => [document.role, document.provenance])).toEqual([
      ["slice", issueUrl(70)],
      ["slice", issueUrl(74)],
    ])
  })

  it("admits owner, member, and collaborator comments and preserves chronology", () => {
    const spec = reviewSpecificationFromGitHubIssues([
      closing(snapshot(74, "slice", "body", [
        comment("CONTRIBUTOR", "2026-01-03T00:00:00Z", "contributor"),
        comment("OWNER", "2026-01-01T00:00:00Z", "owner"),
        comment("NONE", "2026-01-04T00:00:00Z", "unaffiliated"),
        comment("COLLABORATOR", "2026-01-05T00:00:00Z", "collaborator"),
        comment("MEMBER", "2026-01-02T00:00:00Z", "member"),
      ])),
    ])
    expect(spec?.comments.map((entry) => entry.text)).toEqual([
      "owner",
      "member",
      "collaborator",
    ])
  })

  it("records an omission marker after dropping earliest comments above 20k", () => {
    const spec = reviewSpecificationFromGitHubIssues([
      closing(snapshot(70, "parent", "parent body", [
        comment("OWNER", "2026-01-01T00:00:00Z", "p".repeat(8_000), 70),
      ])),
      closing(
        snapshot(74, "slice", "slice body", [
          comment("MEMBER", "2026-01-02T00:00:00Z", "s".repeat(8_000)),
          comment("OWNER", "2026-01-03T00:00:00Z", "n".repeat(8_000)),
        ]),
        snapshot(70, "parent", "parent body"),
      ),
    ])
    expect(spec?.comments.map((entry) => entry.createdAt)).toEqual([
      "2026-01-02T00:00:00Z",
      "2026-01-03T00:00:00Z",
    ])
    expect(spec?.documents.map((document) => document.text)).toEqual([
      "parent body",
      "slice body",
    ])
    expect(spec?.commentOmission).toEqual({
      droppedCount: 1,
      droppedCharacters: 8_000,
      cutoff: "2026-01-02T00:00:00Z",
    })
  })

  it("returns no specification when there are no closing issues", () => {
    expect(reviewSpecificationFromGitHubIssues([])).toBeUndefined()
  })
})

describe("loadGitHubSpecification", () => {
  it.effect("degrades GitHub errors to the quiet no-spec path", () =>
    Effect.gen(function* () {
      const spec = yield* loadGitHubSpecification("/repo", 7).pipe(
        Effect.provide(
          gitHubLayer({
            ...unusedGitHubContract,
            viewClosingIssues: () =>
              Effect.fail(
                new GitHubError({
                  operation: "specification",
                  reason: "GitHub unavailable",
                }),
              ),
          }),
        ),
      )
      expect(spec).toBeUndefined()
    }))
})
