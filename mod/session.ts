// The Mod's session policy (#163): what one Claude Code session does around
// the engine's runs. It admits the session's one review, keeps the review's
// in-flight marker so that a reload which loses the run is reported and
// cleaned up by the next load, and hands each finished run's digest to its
// Caller. The hooks module (mod/gauntlet/hooks/register.ts) turns hook events
// into calls here and `$` into ports; it keeps the strip, the log batch and
// the 250ms clock, whose ticks it passes to `tick`.
import * as Option from "effect/Option"
import * as Schema from "effect/Schema"
import type { ReviewRequest } from "../src/run/run.ts"
import type { Engine, EnginePorts, RunResult } from "./engine.ts"
import { commandWords } from "./review-argv.ts"


// The one line of a message to the main agent that the person sees:
// "gauntlet review finished:" and the digest's counts line joined; a message
// of notes alone, its first line.
export const digestHeadline = (text: string): string => {
  const [first = "", second] = text.split("\n").filter((line) => line.trim() !== "")
  return first.endsWith(":") && second !== undefined ? `${first.slice(0, -1)} · ${second}` : first
}

// Words the engine answers at once, as the command's own answer, without
// starting a run.
const ANSWERED_AT_ONCE = new Set(["config", "page", "brief"])

// What /gauntlet or the review tool asked to start.
export interface StartRequest {
  readonly cwd: string
  readonly args: string
  // The subagent whose review tool call started the run; absent for the main
  // agent and /gauntlet.
  readonly agentId?: string | undefined
  // True for the main agent's review tool call, which runs inside its turn.
  readonly isMainTurn?: boolean | undefined
}

// The store outlives a mod update, so its fields keep their names: `argv` is
// the words the review was started with, and `snapshots` the directories the
// run's snapshot was made in, each removed whole when the run is lost. The
// run's `claude -p` children die with the mod that started them.
const InFlight = Schema.Struct({
  startedAt: Schema.Finite,
  argv: Schema.Array(Schema.String),
  cwd: Schema.String,
  runId: Schema.optionalKey(Schema.String),
  snapshots: Schema.Array(Schema.String),
})
type InFlight = typeof InFlight.Type

// This session's in-flight marker: the store is one file for every session on
// the machine, and another session's live run is not lost.
const inflightKey = (sessionId: string) => `inflight:${sessionId}`

// A marker found as the session loads is a run an earlier load lost: it is
// reported loudly, and the snapshot it left behind is removed. This needs no
// engine, so a load whose engine failed still does it.
export const recoverLostRun = async (
  ports: Pick<EnginePorts, "run" | "log" | "store" | "toast" | "append">,
  sessionId: string,
) => {
  const key = inflightKey(sessionId)
  const stored = await ports.store.get(key)
  if (stored === undefined) return
  await ports.store.delete(key).catch((error) => ports.log(`in-flight marker failed: ${String(error)}`))
  const lost = Option.getOrUndefined(Schema.decodeUnknownOption(InFlight)(stored))
  if (lost === undefined) {
    ports.log(`in-flight marker unreadable, dropped: ${JSON.stringify(stored)}`)
    return
  }
  const outcomes: Array<string> = []
  // The lost run's snapshots: its finalizers never ran. Once a snapshot's
  // directory is gone, a prune drops git's record of the worktree in it.
  for (const snapshot of lost.snapshots) {
    const removed = await ports.run(["rm", "-rf", snapshot]).catch((error) => ({ exitCode: 1, stderr: String(error) }))
    outcomes.push(`${snapshot}: ${removed.exitCode === 0 ? "removed" : `not removed (${removed.stderr.trim()})`}`)
  }
  if (lost.snapshots.length > 0) await ports.run(["git", "-C", lost.cwd, "worktree", "prune"]).catch(() => undefined)
  const age = Math.round((Date.now() - lost.startedAt) / 1000)
  const what = lost.runId === undefined ? `the review started ${String(age)}s ago` : `run ${lost.runId}`
  const note = `gauntlet: ${what} (${lost.argv.join(" ")}) was lost when the mod reloaded. ` +
    `${String(lost.snapshots.length)} snapshot worktree(s) removed. ` +
    "Run /gauntlet again."
  ports.log(`${note} ${outcomes.join("; ")}`)
  ports.toast(note, { timeoutMs: 15_000 })
  await ports.append(note).catch((error) => ports.log(`append failed: ${String(error)}`))
}

export const createSession = (
  ports: Pick<EnginePorts, "log" | "store" | "send" | "submit" | "append">,
  engine: Pick<Engine, "start" | "answer" | "running" | "standardsManifest">,
  sessionId: string,
) => {
  const key = inflightKey(sessionId)
  // When this session's one review was claimed. The claim is taken before
  // anything is awaited and given back once the review's ending has stopped
  // its ticks and cleared its marker: a second review is refused until then,
  // and an ending never touches a newer review's ticks or marker.
  let claimedAt: number | undefined
  // The review the ticks mark, from its first marker to its ending, with the
  // work its marker last recorded.
  let ticking: { readonly cwd: string; marked: string } | undefined
  // The main agent's turn, for the digest's way to it (#146): an appended
  // digest lands between a running turn's tool calls, and a submitted one
  // starts a turn when the agent is idle. An append during the turn's last
  // model call is read by no later step, so the turn's end submits it.
  let busy = false
  let unread: string | undefined

  // The marker outlives this module: a reload (or a crashed session) that
  // loses the run leaves it behind for the next load to report.
  const mark = (marker: InFlight | undefined) =>
    (marker === undefined ? ports.store.delete(key) : ports.store.set(key, marker))
      .catch((error) => ports.log(`in-flight marker failed: ${String(error)}`))

  // Re-marks the review when its snapshot changed; answers whether a review
  // is running, for the strip's pulse.
  const tick = async (): Promise<boolean> => {
    const review = ticking
    const running = engine.running()
    if (review === undefined || running === undefined) return false
    const work = JSON.stringify(running.snapshots)
    if (work !== review.marked) {
      review.marked = work
      await mark({ ...running, cwd: review.cwd })
    }
    return true
  }

  // Starts a review or a delivery in the background and answers the command's
  // one line; `config` answers with its output and runs nothing.
  const start = async (request: StartRequest): Promise<string> => {
    // A reload mid-turn misses that turn's start, and a digest submitted then
    // waits for the turn's end instead of landing in it.
    if (request.isMainTurn === true) busy = true
    const words = commandWords(request.args)
    if (ANSWERED_AT_ONCE.has(words[0] ?? "")) return engine.answer({ words, cwd: request.cwd })
    if (claimedAt !== undefined) {
      return `a review is already running (${engine.running()?.runId ?? "starting"}, ${String(Math.round((Date.now() - claimedAt) / 1000))}s); one per session.`
    }
    claimedAt = Date.now()
    return startRun(request)
  }

  const startRun = async (request: StartRequest): Promise<string> => {
    const words = commandWords(request.args)
    ports.log(`starting ${words.join(" ")} in ${request.cwd}`)
    const run = engine.start({ words, cwd: request.cwd }, (line) => ports.log(`cli: ${line}`))
    if (words[0] === "deliver") {
      void run.ended.then(async (result) => {
        await release()
        await answer(result, request)
      })
        .catch((error) => ports.log(`delivery failed to finish: ${String(error)}`))
      return `delivering ${words.slice(1).join(" ")}; the outcome arrives as a message.`
    }
    // The review runs where its words say (`--repo`), and its marker is down
    // before its ending clears it; a failed marker write only logs.
    const marked = run.request.then(async (review) => {
      if (review === undefined) return
      await mark({ startedAt: Date.now(), argv: words, cwd: review.directory, snapshots: [] })
      ticking = { cwd: review.directory, marked: "" }
    })
    // A review that posts hands off its digest while it still holds the
    // session; the post's outcome is the strip's alone.
    const digestSent = run.reviewed.then(async (result) => {
      if (result === undefined) return false
      await marked
      await answer(result, request)
      return true
    }).catch((error) => {
      ports.log(`digest failed to send: ${String(error)}`)
      return false
    })
    void run.ended.then(async (result) => {
      await marked
      await release()
      if (await digestSent) ports.log(`run ${result.verdict} after ${String(result.seconds)}s: ${result.notes.join("; ")}`)
      else await answer(result, request)
    }).catch((error) => ports.log(`run failed to finish: ${String(error)}`))
    const review = await run.request
    if (review === undefined) return "the review did not start; why arrives as a message."
    const target = words.slice(1).join(" ")
    return `${words[0] === "demo" ? "demo " : ""}review started${target === "" ? "" : ` (${target})`}${review.directory === request.cwd ? "" : ` in ${review.directory}`}; progress shows above the prompt, and the digest arrives as a message when it finishes.` +
      (await standardsNote(review))
  }

  // A repository with no Standards Manifest, on a review that would run the
  // standards lens, gets the offer the gauntlet-code-review skill describes.
  const standardsNote = async (review: ReviewRequest): Promise<string> => {
    if (review.selectedLensNames !== undefined && !review.selectedLensNames.includes("standards")) return ""
    const manifest = await engine.standardsManifest(review.directory).catch((error) => {
      ports.log(`standards manifest check failed: ${String(error)}`)
      return undefined
    })
    return manifest === undefined || manifest.exists
      ? ""
      : ` This repository has no Standards Manifest, so the standards lens is skipped this time; it goes at ${manifest.path}. Offer to set it up, as the gauntlet-code-review skill says.`
  }

  // A run's ending stops its ticks, clears its marker and gives the session
  // back before its answer is on its way.
  const release = async () => {
    ticking = undefined
    await mark(undefined)
    claimedAt = undefined
  }

  // Says a digest, or what ended the run, to the Caller.
  const answer = async (result: RunResult, request: StartRequest) => {
    const { digest, verdict, notes } = result
    ports.log(`run ${verdict} after ${String(result.seconds)}s`)
    // Without a digest, the notes say what happened; the verdict stands in
    // only when there are none (a cancelled run).
    const text = digest === ""
      ? `gauntlet: ${(notes.length === 0 ? [verdict] : notes).join("\n")}`
      : `gauntlet ${verdict}:\n\n${digest}${notes.length === 0 ? "" : `\n\n${notes.join("\n")}`}`
    await handOff(text, request.agentId)
  }

  // A subagent that started the review gets its digest as a message, which
  // reaches it between tool calls or resumes it once it has stopped; when it
  // cannot be reached, the main agent gets it. The main agent's copy is an
  // appended row, which the model reads and the person does not see; the
  // prompt that wakes an idle agent (or ends a turn whose last model call
  // missed the row) is its one-line headline, the only part the person sees,
  // as the CLI's ending is one notification row.
  const handOff = async (text: string, agentId: string | undefined) => {
    if (agentId !== undefined) {
      const refused = await ports.send(agentId, text).catch((error) => String(error))
      if (refused === undefined) return
      ports.log(`digest not sent to ${agentId}: ${refused}`)
    }
    const appended = await ports.append(text).then(
      () => true,
      (error) => {
        ports.log(`append failed: ${String(error)}`)
        return false
      },
    )
    // With no row to read, the prompt carries the whole text.
    const prompt = appended ? digestHeadline(text) : text
    // Busy, the main agent reads the row at its next step, or its turn's end
    // submits the prompt.
    if (busy) unread = unread === undefined ? prompt : `${unread}\n\n${prompt}`
    else await submit(prompt)
  }

  // A dropped prompt leaves the digest to the appended row, or, when that
  // append failed too, to the log alone.
  const submit = async (text: string) => {
    const dropped = await ports.submit(text).catch((error) => String(error))
    if (dropped !== undefined) ports.log(`submit dropped: ${dropped}`)
  }

  return {
    start,
    tick,
    // The main agent's turns: started, each model call, and the end.
    turnStarted: () => {
      busy = true
    },
    stepped: () => {
      unread = undefined
    },
    turnEnded: async () => {
      busy = false
      const left = unread
      unread = undefined
      if (left !== undefined) await submit(left)
    },
  }
}

export type Session = ReturnType<typeof createSession>
