import * as Option from "effect/Option"
import type { Json } from "effect/Schema"
import { describe, expect, it } from "vitest"
import type { ReviewRequest } from "../src/run/run.ts"
import { SubmissionTargetRequest } from "../src/run/submission.ts"
import type { BuildInfo, RunResult } from "./engine.ts"
import { createSession, digestHeadline, recoverLostRun, type StartRequest } from "./session.ts"

const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

// Lets the session's promises settle until `ready`, for a bounded while: a
// condition that never holds fails the assertions after it.
const until = async (ready: () => boolean) => {
  for (let turns = 0; turns < 1000 && !ready(); turns += 1) await settle()
}

// A port call the test lets go of.
const held = () => {
  let release: () => void = () => {}
  const gate = new Promise<void>((resolve) => (release = resolve))
  return { gate, release }
}

const MARKER = "inflight:session-1"
const REVIEW: ReviewRequest = {
  target: SubmissionTargetRequest.WorkingTree({ base: undefined }),
  recipeName: Option.none(),
  selectedLensNames: ["fixture-lens"],
  directory: "/repo",
  specPath: undefined,
}
const FINISHED: RunResult = { verdict: "review finished", digest: "1 finding\nfixture.ts:3", notes: [], seconds: 3 }
const DIGEST = "gauntlet review finished:\n\n1 finding\nfixture.ts:3"
const POSTED: RunResult = { verdict: "delivered", digest: "", notes: ["posted https://github.com/o/r/pull/7#c"], seconds: 9 }

// The engine's slice the session drives, scripted: the test parses each
// started run's words into a review, hands off a posting review's digest and
// ends it.
const makeEngine = () => {
  type Running = { runId: string | undefined; startedAt: number; argv: ReadonlyArray<string>; snapshots: Array<string> }
  let running: Running | undefined
  const runs: Array<{
    readonly parse: (review: ReviewRequest | undefined) => void
    readonly post: (result: RunResult) => void
    readonly end: (result: RunResult) => void
  }> = []
  const engine = {
    start: (request: { readonly words: ReadonlyArray<string> }) => {
      let parse: (review: ReviewRequest | undefined) => void = () => {}
      let post: (result: RunResult | undefined) => void = () => {}
      let end: (result: RunResult) => void = () => {}
      const parsed = new Promise<ReviewRequest | undefined>((resolve) => (parse = resolve))
      const reviewed = new Promise<RunResult | undefined>((resolve) => (post = resolve))
      const ended = new Promise<RunResult>((resolve) => (end = resolve))
      running = { runId: undefined, startedAt: Date.now(), argv: request.words, snapshots: [] }
      runs.push({
        parse,
        post,
        end: (result) => {
          running = undefined
          parse(undefined)
          post(undefined)
          end(result)
        },
      })
      return { request: parsed, reviewed, ended }
    },
    config: async (request: { readonly words: ReadonlyArray<string> }) => `config ${request.words.slice(1).join(" ")}`,
    running: () => running,
    standardsManifest: async () => ({ path: "/standards", exists: true }),
  }
  return { engine, runs, working: () => running }
}

const makeSession = (options: {
  readonly deleted?: Promise<void>
  readonly submitted?: Promise<void>
  readonly sendRefusal?: string
  readonly submitDrop?: string
} = {}) => {
  // A recent update check: no review here probes for a release.
  const store = new Map<string, Json>([["update-checked-at", Date.now()]])
  const ran: Array<ReadonlyArray<string>> = []
  const sent: Array<string> = []
  const submitted: Array<string> = []
  const appended: Array<string> = []
  let deletes = 0
  const build: BuildInfo = { stamp: "", files: 0, repoRoot: "/gauntlet", builtAt: "", bun: "bun" }
  const ports: Parameters<typeof createSession>[0] & Parameters<typeof recoverLostRun>[0] = {
    // Git lists no inputs, so the stamp is the same on every check.
    run: async (argv) => {
      ran.push(argv)
      return { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
    },
    read: async () => JSON.stringify({ ...build, stamp: STAMP }),
    log: () => {},
    store: {
      get: async (key) => store.get(key),
      set: async (key, value) => {
        store.set(key, value)
      },
      delete: async (key) => {
        deletes += 1
        await options.deleted
        store.delete(key)
      },
    },
    toast: () => {},
    status: () => {},
    send: async (agentId, text) => {
      sent.push(`${agentId}: ${text}`)
      return options.sendRefusal
    },
    submit: async (text) => {
      submitted.push(text)
      await options.submitted
      return options.submitDrop
    },
    append: async (text) => {
      appended.push(text)
    },
  }
  const { engine, runs, working } = makeEngine()
  const session = createSession(ports, engine, { build, pluginRoot: "/plugins/gauntlet", sessionId: "session-1" })
  // Starts a review and parses its words; answers the command's line.
  const review = async (request: StartRequest) => {
    const answer = session.start(request)
    const count = runs.length
    await until(() => runs.length > count)
    runs[count]?.parse(REVIEW)
    return {
      answer: await answer,
      post: (result: RunResult) => runs[count]?.post(result),
      end: (result: RunResult) => runs[count]?.end(result),
    }
  }
  // A start's refusal, or "admitted" once it starts a run.
  const attempt = (request: StartRequest) => {
    const count = runs.length
    return Promise.race([session.start(request), until(() => runs.length > count).then(() => "admitted")])
  }
  return {
    ports,
    session,
    review,
    attempt,
    runs,
    working,
    store,
    ran,
    sent,
    submitted,
    appended,
    get deletes() {
      return deletes
    },
  }
}

// The stamp of a checkout whose git lists no inputs.
const STAMP = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"

describe("the Mod's session", () => {
  it("admits one of two overlapping starts and refuses the other", async () => {
    const mod = makeSession()
    const first = mod.review({ cwd: "/repo", args: "--recipe one" })
    const second = await mod.attempt({ cwd: "/repo", args: "--recipe two" })

    expect(second).toMatch(/^a review is already running \(starting, \d+s\); one per session\.$/)
    expect((await first).answer).toMatch(/^review started \(--recipe one\)/)
    expect(mod.runs).toHaveLength(1)
  })

  it("never lets an old review's ending clear a newer review's marker or stop its ticks", async () => {
    const deleting = held()
    const submitting = held()
    const mod = makeSession({ deleted: deleting.gate, submitted: submitting.gate })
    const first = await mod.review({ cwd: "/repo", args: "--recipe one" })
    first.end(FINISHED)

    // Until the ending has cleared its marker, the review still holds the
    // session.
    await until(() => mod.deletes === 1)
    expect(await mod.attempt({ cwd: "/repo", args: "--recipe two" })).toMatch(/one per session/)
    deleting.release()
    await until(() => mod.submitted.length === 1)

    // The first review's digest is still on its way as the second starts.
    const second = await mod.review({ cwd: "/repo", args: "--recipe two" })
    expect(second.answer).toMatch(/^review started \(--recipe two\)/)
    submitting.release()
    await settle()
    mod.working()?.snapshots.push("/tmp/gauntlet-review-2")

    expect(await mod.session.tick()).toBe(true)
    expect(mod.store.get(MARKER)).toMatchObject({ argv: ["review", "--recipe", "two"], snapshots: ["/tmp/gauntlet-review-2"] })
  })


  it("hands off a posting review's digest before its post ends, holding the session until the post does and saying nothing more", async () => {
    const submitting = held()
    const mod = makeSession({ submitted: submitting.gate })
    const run = await mod.review({ cwd: "/repo", args: "--pr 7 --destination pr" })
    run.post(FINISHED)
    await until(() => mod.submitted.length === 1)

    expect(mod.submitted).toEqual([DIGEST])
    expect(await mod.attempt({ cwd: "/repo", args: "" })).toMatch(/one per session/)
    expect(mod.store.has(MARKER)).toBe(true)

    // The post's ending gives the session back though the digest is still on
    // its way; its outcome is the strip's alone.
    run.end(POSTED)
    await until(() => !mod.store.has(MARKER))
    submitting.release()
    await settle()

    expect([mod.submitted, mod.appended]).toEqual([[DIGEST], []])
  })

  it("reports a lost review at session start, removing its snapshot", async () => {
    const mod = makeSession()
    mod.store.set(MARKER, {
      startedAt: Date.now(),
      argv: ["review", "main"],
      cwd: "/repo",
      runId: "run-1",
      snapshots: ["/tmp/gauntlet-review-1"],
    })

    await recoverLostRun(mod.ports, "session-1")

    expect(mod.ran).toEqual([["rm", "-rf", "/tmp/gauntlet-review-1"], ["git", "-C", "/repo", "worktree", "prune"]])
    expect(mod.store.has(MARKER)).toBe(false)
    expect(mod.appended).toEqual([expect.stringMatching(/^gauntlet: run run-1 \(review main\) was lost when the mod reloaded\. 1 snapshot worktree\(s\) removed/)])
  })
})

describe("the digest's way to its Caller", () => {
  it("reaches the subagent that started the review", async () => {
    const mod = makeSession()
    const run = await mod.review({ cwd: "/repo", args: "", agentId: "agent-9" })
    run.end(FINISHED)
    await until(() => mod.sent.length === 1)

    expect(mod.sent).toEqual([`agent-9: ${DIGEST}`])
    expect([mod.submitted, mod.appended]).toEqual([[], []])
  })

  it("wakes the main agent when the subagent cannot be reached", async () => {
    const mod = makeSession({ sendRefusal: "no live agent" })
    const run = await mod.review({ cwd: "/repo", args: "", agentId: "agent-9" })
    run.end(FINISHED)
    await until(() => mod.submitted.length === 1)

    expect(mod.submitted).toEqual([DIGEST])
    expect(mod.appended).toEqual([])
  })

  it("submits at the turn's end a digest appended after the turn's last model call", async () => {
    const mod = makeSession()
    mod.session.turnStarted()
    mod.session.stepped()
    const run = await mod.review({ cwd: "/repo", args: "" })
    run.end(FINISHED)
    await until(() => mod.appended.length === 1)
    expect(mod.submitted).toEqual([])

    await mod.session.turnEnded()

    expect(mod.submitted).toEqual([DIGEST])
  })

  it("leaves to the turn a digest that a later step read", async () => {
    const mod = makeSession()
    mod.session.turnStarted()
    const run = await mod.review({ cwd: "/repo", args: "" })
    run.end(FINISHED)
    await until(() => mod.appended.length === 1)

    mod.session.stepped()
    await mod.session.turnEnded()

    expect(mod.submitted).toEqual([])
  })

  it("appends into the turn whose tool call started the review, though a reload missed its start", async () => {
    const mod = makeSession()
    const run = await mod.review({ cwd: "/repo", args: "", isMainTurn: true })
    run.end(FINISHED)
    await until(() => mod.appended.length === 1)

    mod.session.stepped()
    await mod.session.turnEnded()

    expect([mod.submitted, mod.appended]).toEqual([[], [DIGEST]])
  })

  it("leaves the digest appended when its submit is dropped", async () => {
    const mod = makeSession({ submitDrop: "fixture drop" })
    const run = await mod.review({ cwd: "/repo", args: "" })
    run.end(FINISHED)
    await until(() => mod.appended.length === 1)

    expect([mod.submitted, mod.appended]).toEqual([[DIGEST], [DIGEST]])
  })
})

describe("the digest's row in the transcript", () => {
  it("draws the verdict and the counts line as one line, and a notes-only message as its first", () => {
    expect(digestHeadline("gauntlet review finished:\n\n1 confirmed · 0 kept — 42s\n- [P2 confirmed] a.ts:1 — x\n\ndossier.md: /r/dossier.md"))
      .toBe("gauntlet review finished · 1 confirmed · 0 kept — 42s")
    expect(digestHeadline("gauntlet: could not review — no such ref\nmore")).toBe("gauntlet: could not review — no such ref")
  })
})
