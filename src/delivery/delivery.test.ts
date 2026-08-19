import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Schema from "effect/Schema"
import { DeliveryReceipt } from "../domain/delivery-receipt.ts"
import { Dossier } from "../domain/dossier.ts"
import { FrozenLens, ReviewPlan } from "../domain/review-plan.ts"
import { ReviewTarget, targetIdentityOf } from "../domain/review-target.ts"
import {
  GitHubError,
  gitHubLayer,
  unusedGitHubContract,
  type PostedComment,
} from "../github/github.ts"
import { writeArtifactJson, writeArtifactText } from "../run/artifact.ts"
import { runPaths } from "../run/run-record.ts"
import {
  fitPostedDossier,
  FULL_DOSSIER_NOTE,
  SAFE_PR_COMMENT_BYTES,
} from "./comment-body.ts"
import { deliverCompletedRun, DeliveryError } from "./delivery.ts"

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

const prTarget = ReviewTarget.cases.PullRequest.make({
  repoRoot: "/fixture/repo",
  number: 7,
  headCommit: "abc1234",
  baseCommit: "def5678",
  changedFiles: ["src/alpha.ts"],
  diff: "+needle",
  warnings: [],
})

const workingTreeTarget = ReviewTarget.cases.WorkingTree.make({
  repoRoot: "/fixture/repo",
  headCommit: "abc1234",
  changedFiles: ["src/alpha.ts"],
  diff: "+needle",
  untrackedFiles: [],
  warnings: [],
})

const planFor = (target: ReviewTarget, runId = "run-fixture") =>
  ReviewPlan.make({
    runId,
    target,
    seats: {},
    lenses: [
      FrozenLens.make({
        name: "fixture-lens",
        promptText: "fixture tail",
        seat: "fixture/fixture-model:low",
        candidateCap: 6,
      }),
    ],
  })

const dossierFor = (target: ReviewTarget, runId = "run-fixture") =>
  Dossier.make({
    runId,
    target: targetIdentityOf(target),
    findings: [],
    unresolved: [],
    rejected: { refutedClaims: [], droppedObservations: [] },
    coverageGaps: [],
  })

const IDENTITY = `# Gauntlet review run-fixture

- Target: PR #7 (head abc1234)
- Recipe: fixture-recipe
`

const markdownFor = (evidence: string) =>
  `${IDENTITY}
## Findings

${evidence}
`

interface ScriptedGitHub {
  readonly posts: Array<{
    readonly cwd: string
    readonly number: number
    readonly body: string
  }>
  failPost: string | undefined
  readonly url: string
}

const scriptedGitHub = (
  script: ScriptedGitHub,
) =>
  gitHubLayer({
    ...unusedGitHubContract,
    postComment: (cwd, number, body) => {
      script.posts.push({ cwd, number, body })
      return script.failPost === undefined
        ? Effect.succeed<PostedComment>({ url: script.url })
        : Effect.fail(
          new GitHubError({ operation: "post", reason: script.failPost }),
        )
    },
  })

const writeCompletedRun = (
  root: string,
  target: ReviewTarget,
  markdown: string,
) =>
  Effect.gen(function* () {
    const path = yield* Path.Path
    const fs = yield* FileSystem.FileSystem
    const paths = runPaths(root, "run-fixture", path)
    yield* fs.makeDirectory(paths.root, { recursive: true })
    const plan = planFor(target)
    yield* writeArtifactJson(paths.plan, ReviewPlan, plan)
    yield* writeArtifactJson(paths.dossier, Dossier, dossierFor(target))
    yield* writeArtifactText(paths.dossierMarkdown, markdown)
    return { paths, plan }
  })

describe("fitPostedDossier", () => {
  it("leaves a fitting Dossier unchanged", () => {
    const markdown = markdownFor("- **[P1]** src/alpha.ts:1 — a real bug")
    expect(fitPostedDossier(markdown)).toEqual({
      body: markdown,
      truncated: false,
    })
  })

  it("truncates evidence before identity and points at the run directory", () => {
    const markdown = markdownFor(`- **[P1]** src/alpha.ts:1 — ${"e".repeat(70_000)}`)
    const fitted = fitPostedDossier(markdown)
    expect(fitted.truncated).toBe(true)
    expect(fitted.body).toContain("Gauntlet review run-fixture")
    expect(fitted.body).toContain("PR #7 (head abc1234)")
    expect(fitted.body).toContain(FULL_DOSSIER_NOTE)
    expect(fitted.body).not.toContain("e".repeat(70_000))
    expect(utf8Bytes(fitted.body)).toBeLessThanOrEqual(SAFE_PR_COMMENT_BYTES)
  })

  it("bounds an oversized pre-Findings prefix", () => {
    const markdown = `# Gauntlet review run-fixture\n\n${"n".repeat(70_000)}\n## Findings\n\n- finding`
    const fitted = fitPostedDossier(markdown)

    expect(fitted.truncated).toBe(true)
    expect(fitted.body).toContain("Gauntlet review run-fixture")
    expect(fitted.body).toContain(FULL_DOSSIER_NOTE)
    expect(fitted.body).not.toContain("- finding")
    expect(utf8Bytes(fitted.body)).toBeLessThanOrEqual(SAFE_PR_COMMENT_BYTES)
  })
})

describe("deliverCompletedRun", () => {
  it.effect("posts dossier.md and records a Posted receipt", () =>
    Effect.gen(function* () {
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "gauntlet-delivery-" })
        ),
      )
      const markdown = markdownFor("- **[P1]** src/alpha.ts:1 — a real bug")
      const loaded = yield* writeCompletedRun(root, prTarget, markdown)
      const script: ScriptedGitHub = {
        posts: [],
        failPost: undefined,
        url: "https://github.com/example/repo/pull/7#issuecomment-1",
      }

      const receipt = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
      )

      expect(DeliveryReceipt.guards.Posted(receipt)).toBe(true)
      if (DeliveryReceipt.guards.Posted(receipt)) {
        expect(receipt.url).toBe(script.url)
        expect(receipt.truncated).toBe(false)
      }
      expect(script.posts).toHaveLength(1)
      expect(script.posts[0]?.number).toBe(7)
      expect(script.posts[0]?.body).toBe(markdown)
      expect(script.posts[0]?.body.startsWith("{")).toBe(false)

      const stored = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(loaded.paths.receipt)),
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(DeliveryReceipt)),
        ),
      )
      expect(stored).toEqual(receipt)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("re-delivers a Posted receipt as an idempotent no-op", () =>
    Effect.gen(function* () {
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "gauntlet-delivery-" })
        ),
      )
      const loaded = yield* writeCompletedRun(
        root,
        prTarget,
        markdownFor("- **[P1]** src/alpha.ts:1 — a real bug"),
      )
      const script: ScriptedGitHub = {
        posts: [],
        failPost: undefined,
        url: "https://github.com/example/repo/pull/7#issuecomment-1",
      }
      const first = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
      )
      const second = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
      )

      expect(second).toEqual(first)
      expect(script.posts).toHaveLength(1)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("retries a NotPosted receipt and records Posted on success", () =>
    Effect.gen(function* () {
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "gauntlet-delivery-" })
        ),
      )
      const loaded = yield* writeCompletedRun(
        root,
        prTarget,
        markdownFor("- **[P1]** src/alpha.ts:1 — a real bug"),
      )
      const script: ScriptedGitHub = {
        posts: [],
        failPost: "GitHub unavailable",
        url: "https://github.com/example/repo/pull/7#issuecomment-9",
      }

      const failed = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
        Effect.flip,
      )
      expect(failed).toBeInstanceOf(DeliveryError)
      expect(failed.reason).toBe("GitHub unavailable")
      const notPosted = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(loaded.paths.receipt)),
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(DeliveryReceipt)),
        ),
      )
      expect(DeliveryReceipt.guards.NotPosted(notPosted)).toBe(true)

      script.failPost = undefined
      const posted = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
      )
      expect(DeliveryReceipt.guards.Posted(posted)).toBe(true)
      if (DeliveryReceipt.guards.Posted(posted)) {
        expect(posted.url).toBe(script.url)
      }
      expect(script.posts).toHaveLength(2)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("posts a truncated body when the Dossier is oversize", () =>
    Effect.gen(function* () {
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "gauntlet-delivery-" })
        ),
      )
      const markdown = markdownFor(`- **[P1]** src/alpha.ts:1 — ${"e".repeat(70_000)}`)
      const loaded = yield* writeCompletedRun(root, prTarget, markdown)
      const script: ScriptedGitHub = {
        posts: [],
        failPost: undefined,
        url: "https://github.com/example/repo/pull/7#issuecomment-1",
      }

      const receipt = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
      )
      expect(DeliveryReceipt.guards.Posted(receipt)).toBe(true)
      if (DeliveryReceipt.guards.Posted(receipt)) {
        expect(receipt.truncated).toBe(true)
      }
      expect(script.posts[0]?.body).toContain(FULL_DOSSIER_NOTE)
      expect(script.posts[0]?.body).toContain("Gauntlet review run-fixture")
      expect(utf8Bytes(script.posts[0]?.body ?? "")).toBeLessThanOrEqual(
        SAFE_PR_COMMENT_BYTES,
      )
      expect(yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(loaded.paths.dossierMarkdown)),
      )).toBe(markdown)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("leaves the Dossier in place when posting fails", () =>
    Effect.gen(function* () {
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "gauntlet-delivery-" })
        ),
      )
      const markdown = markdownFor("- **[P1]** src/alpha.ts:1 — a real bug")
      const loaded = yield* writeCompletedRun(root, prTarget, markdown)
      const script: ScriptedGitHub = {
        posts: [],
        failPost: "permission denied",
        url: "https://github.com/example/repo/pull/7#issuecomment-1",
      }

      const failed = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
        Effect.flip,
      )
      expect(failed).toBeInstanceOf(DeliveryError)

      expect(yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(loaded.paths.dossierMarkdown)),
      )).toBe(markdown)
      expect(yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(loaded.paths.dossier)),
      )).toContain("run-fixture")
      const receipt = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.readFileString(loaded.paths.receipt)),
        Effect.flatMap(
          Schema.decodeEffect(Schema.fromJsonString(DeliveryReceipt)),
        ),
      )
      expect(receipt).toEqual(
        DeliveryReceipt.cases.NotPosted.make({
          runId: "run-fixture",
          reason: "permission denied",
        }),
      )
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("refuses a working-tree run before posting", () =>
    Effect.gen(function* () {
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "gauntlet-delivery-" })
        ),
      )
      const loaded = yield* writeCompletedRun(
        root,
        workingTreeTarget,
        markdownFor("- **[P1]** src/alpha.ts:1 — a real bug"),
      )
      const script: ScriptedGitHub = {
        posts: [],
        failPost: undefined,
        url: "https://github.com/example/repo/pull/7#issuecomment-1",
      }

      const failed = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
        Effect.flip,
      )

      expect(failed).toBeInstanceOf(DeliveryError)
      expect(failed.operation).toBe("load")
      expect(failed.reason).toContain("not a pull-request review")
      expect(script.posts).toHaveLength(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))

  it.effect("maps an unreadable receipt to DeliveryError", () =>
    Effect.gen(function* () {
      const root = yield* FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) =>
          fs.makeTempDirectoryScoped({ prefix: "gauntlet-delivery-" })
        ),
      )
      const loaded = yield* writeCompletedRun(
        root,
        prTarget,
        markdownFor("- **[P1]** src/alpha.ts:1 — a real bug"),
      )
      const fs = yield* FileSystem.FileSystem
      yield* fs.makeDirectory(loaded.paths.receipt)
      const script: ScriptedGitHub = {
        posts: [],
        failPost: undefined,
        url: "https://github.com/example/repo/pull/7#issuecomment-1",
      }

      const failed = yield* deliverCompletedRun(loaded).pipe(
        Effect.provide(scriptedGitHub(script)),
        Effect.flip,
      )

      expect(failed).toBeInstanceOf(DeliveryError)
      expect(failed.operation).toBe("load")
      expect(failed.reason).toContain("delivery receipt")
      expect(script.posts).toHaveLength(0)
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)))
})
