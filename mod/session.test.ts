import * as Option from "effect/Option"
import type { Json } from "effect/Schema"
import { describe, expect, it } from "vitest"
import type { ReviewRequest } from "../src/run/run.ts"
import { SubmissionTargetRequest } from "../src/run/submission.ts"
import type { BuildInfo, RunResult } from "./engine.ts"
import { createSession, recoverLostRun, type StartRequest } from "./session.ts"

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

// The engine's slice the session drives, scripted: the test parses each
// started run's words into a review and ends it.
const makeEngine = (polled: Promise<void>) => {
  type Running = { runId: string | undefined; startedAt: number; argv: ReadonlyArray<string>; agentIds: Array<string>; snapshots: Array<string> }
  let running: Running | undefined
  const runs: Array<{ readonly parse: (review: ReviewRequest | undefined) => void; readonly end: (result: RunResult) => void }> = []
  const engine = {
    start: (request: { readonly words: ReadonlyArray<string> }) => {
      let parse: (review: ReviewRequest | undefined) => void = () => {}
      let end: (result: RunResult) => void = () => {}
      const parsed = new Promise<ReviewRequest | undefined>((resolve) => (parse = resolve))
      const ended = new Promise<RunResult>((resolve) => (end = resolve))
      running = { runId: undefined, startedAt: Date.now(), argv: request.words, agentIds: [], snapshots: [] }
      runs.push({
        parse,
        end: (result) => {
          running = undefined
          parse(undefined)
          end(result)
        },
      })
      return { request: parsed, ended }
    },
    running: () => running,
    poll: () => polled,
    standardsManifest: async () => ({ path: "/standards", exists: true }),
  }
  return { engine, runs, working: () => running }
}

const makeSession = (options: {
  readonly polled?: Promise<void>
  readonly deleted?: Promise<void>
  readonly submitted?: Promise<void>
  readonly sendRefusal?: string
  readonly submitDrop?: string
} = {}) => {
  // A recent update check: no review here probes for a release.
  const store = new Map<string, Json>([["update-checked-at", Date.now()]])
  const ran: Array<ReadonlyArray<string>> = []
  const stopped: Array<string> = []
  const sent: Array<string> = []
  const submitted: Array<string> = []
  const appended: Array<string> = []
  const rows: Array<string> = []
  let deletes = 0
  const build: BuildInfo = { stamp: "", files: 0, repoRoot: "/gauntlet", builtAt: "", bun: "bun", prices: {} }
  const ports: Parameters<typeof createSession>[0] & Parameters<typeof recoverLostRun>[0] = {
    // Git lists no inputs, so the stamp is the same on every check.
    run: async (argv) => {
      ran.push(argv)
      return { exitCode: 0, stdout: "", stderr: "", isStdoutTruncated: false, isStderrTruncated: false }
    },
    read: async () => JSON.stringify({ ...build, stamp: STAMP }),
    stop: async (agentId) => {
      stopped.push(agentId)
      return undefined
    },
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
    row: (line) => rows.push(line),
  }
  const { engine, runs, working } = makeEngine(options.polled ?? Promise.resolve())
  const session = createSession(ports, engine, { build, pluginRoot: "/plugins/gauntlet", sessionId: "session-1" })
  // Starts a review and parses its words; answers the command's line.
  const review = async (request: StartRequest) => {
    const answer = session.start(request)
    const count = runs.length
    await until(() => runs.length > count)
    runs[count]?.parse(REVIEW)
    return { answer: await answer, end: (result: RunResult) => runs[count]?.end(result) }
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
    stopped,
    sent,
    submitted,
    appended,
    rows,
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
    mod.working()?.agentIds.push("agent-2")

    expect(await mod.session.tick()).toBe(true)
    expect(mod.store.get(MARKER)).toMatchObject({ argv: ["review", "--recipe", "two"], agentIds: ["agent-2"] })
  })

  it("never rewrites the marker of a review that ended during a tick's poll", async () => {
    const polling = held()
    const mod = makeSession({ polled: polling.gate })
    const run = await mod.review({ cwd: "/repo", args: "" })
    expect(run.answer).toMatch(/^review started; progress shows/)
    await until(() => mod.store.has(MARKER))
    mod.working()?.agentIds.push("agent-1")

    const ticked = mod.session.tick()
    run.end(FINISHED)
    await until(() => mod.submitted.length === 1)
    polling.release()

    expect(await ticked).toBe(false)
    expect(mod.store.has(MARKER)).toBe(false)
  })

  it("reports a lost review at session start, stopping its agents and removing its snapshot", async () => {
    const mod = makeSession()
    mod.store.set(MARKER, {
      startedAt: Date.now(),
      argv: ["review", "main"],
      cwd: "/repo",
      runId: "run-1",
      agentIds: ["agent-1"],
      snapshots: ["/tmp/gauntlet-review-1"],
    })

    await recoverLostRun(mod.ports, "session-1")

    expect(mod.stopped).toEqual(["agent-1"])
    expect(mod.ran).toEqual([["rm", "-rf", "/tmp/gauntlet-review-1"], ["git", "-C", "/repo", "worktree", "prune"]])
    expect(mod.store.has(MARKER)).toBe(false)
    expect(mod.appended).toEqual([expect.stringMatching(/^gauntlet: run run-1 \(review main\) was lost when the mod reloaded\. 1 orphaned/)])
  })
})

describe("the digest's way to its Caller", () => {
  it("reaches the subagent that started the review", async () => {
    const mod = makeSession()
    const run = await mod.review({ cwd: "/repo", args: "", agentId: "agent-9" })
    run.end(FINISHED)
    await until(() => mod.sent.length === 1)

    expect(mod.sent).toEqual([`agent-9: ${DIGEST}`])
    expect([mod.submitted, mod.appended, mod.rows]).toEqual([[], [], ["1 finding", "fixture.ts:3"]])
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

  it("leaves the digest appended when its submit is dropped", async () => {
    const mod = makeSession({ submitDrop: "fixture drop" })
    const run = await mod.review({ cwd: "/repo", args: "" })
    run.end(FINISHED)
    await until(() => mod.appended.length === 1)

    expect([mod.submitted, mod.appended, mod.rows]).toEqual([[DIGEST], [DIGEST], ["1 finding", "fixture.ts:3"]])
  })
})
