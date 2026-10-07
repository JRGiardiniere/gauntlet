// gc-cli's engine (#134 Idea 3): the Gauntlet review program itself, run
// in process inside Claude Code. `bun run build-mod` bundles this entry,
// Effect included, into the plugin's hooks/vendor/engine.js; the hooks
// module (mod/gc-cli/hooks/register.ts) hands it ports over `$` and relays
// the hooks' observations. There is no second pipeline: argv goes to the CLI's
// own review command (src/cli/review.ts), which runs Submission, the
// snapshot worktree, invoke.ts deadlines and corrective turns, the Stages,
// the run record and the digest exactly as `gauntlet review` does. Only the
// platform services and the HarnessSession adapter differ.
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import { runReviewCli } from "../src/cli/review.ts"
import { liveGitHubLayer } from "../src/github/github.ts"
import {
  type ClaudeModelCost,
  claudePrice,
  makeClaudeHost,
} from "../src/harness/claude-host.ts"
import { HarnessSessionFactory } from "../src/harness/harness-session.ts"
import { Linear } from "../src/linear/linear.ts"
import { type RunMilestone, RunMilestones } from "../src/run/run-milestones.ts"
import { InvocationDirectory } from "../src/target/invocation-directory.ts"
import { type AgentPorts, makeAgentDriver, type TurnComplete } from "./agents.ts"
import { platformLayer, type PlatformPorts } from "./platform.ts"
import type { RunView } from "./run-pane.ts"

export { renderRunPane } from "./run-pane.ts"
export type { PaneElements, RunView } from "./run-pane.ts"
export { reviewArgv } from "./review-argv.ts"
export { inputsStamp } from "./stamp.ts"
export type { ToolsEvent, PublishedAgent } from "./agents.ts"

// What `bun run build-mod` writes beside the bundle as vendor/build.json.
export interface BuildInfo {
  readonly stamp: string
  readonly files: number
  readonly repoRoot: string
  readonly builtAt: string
  // The bun that built it, which rebuilds it.
  readonly bun: string
  // Pi's Anthropic catalog, $/Mtok per model id, frozen at build time.
  readonly prices: Readonly<Record<string, ClaudeModelCost>>
}

export interface HttpPort {
  readonly fetch: (
    url: string,
    init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
  ) => Promise<{ readonly status: number; readonly headers: Record<string, string>; readonly text: string }>
}

export interface EnginePorts extends PlatformPorts, AgentPorts, HttpPort {}

export interface RunResult {
  readonly exitCode: number
  // Why the review could not run, as the CLI rendered it.
  readonly refusal: string | undefined
  readonly stdout: string
  readonly stderr: string
  readonly seconds: number
  readonly interrupted: boolean
}

// The mod has no global fetch; Linear's FetchHttpClient gets this one over
// `$.http.fetch`. FetchHttpClient calls it with a URL, a method, a header
// record and a Uint8Array or string body, and reads only status, url,
// headers and arrayBuffer() of the answer (HttpClientResponse.fromWeb).
interface FetchInit {
  readonly method?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly body?: Uint8Array | string | null
}

interface HttpRequest {
  method: string
  headers: Record<string, string>
  body?: string
}

const fetchOver = (http: HttpPort) => {
  const fetch = async (url: URL, init: FetchInit) => {
    const request: HttpRequest = {
      method: init.method ?? "GET",
      headers: { ...init.headers },
    }
    if (init.body instanceof Uint8Array) request.body = new TextDecoder().decode(init.body)
    else if (init.body !== undefined && init.body !== null) request.body = init.body
    const answer = await http.fetch(url.href, request)
    const bytes = new TextEncoder().encode(answer.text)
    return {
      status: answer.status,
      url: url.href,
      headers: Object.entries(answer.headers),
      body: null,
      arrayBuffer: () => Promise.resolve(bytes.buffer),
    }
  }
  // SAFETY: FetchHttpClient uses exactly the call shape and answer slice
  // described above; nothing else of fetch or Response.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions -- the mod has no Response to build
  return fetch as unknown as typeof globalThis.fetch
}

// "2 confirmed · 1 kept · 3 plausible", the digest's tally without its
// target and spend.
const resultCounts = (result: Extract<RunMilestone, { readonly _tag: "Reviewed" }>) => {
  const counted = (tag: string, label: string) => {
    const count = result.entries.filter((entry) => entry.tag === tag).length
    return count === 0 ? [] : [`${String(count)} ${label}`]
  }
  const counts = [
    ...counted("confirmed", "confirmed"),
    ...counted("judgment", "kept"),
    ...counted("plausible", "plausible"),
    ...counted("undecided", "undecided"),
  ]
  return counts.length === 0 ? "no findings" : counts.join(" · ")
}

// The run pane's view less the driver's activity.
type Progress = {
  -readonly [K in Exclude<keyof RunView, "activity">]: RunView[K]
}

export const createEngine = (ports: EnginePorts, build: BuildInfo) => {
  const driver = makeAgentDriver(ports)
  let current:
    | {
      readonly fiber: Fiber.Fiber<number>
      readonly startedAt: number
      readonly argv: ReadonlyArray<string>
      runId: string | undefined
    }
    | undefined
  // What the run pane draws: the run in flight, or the last one, kept
  // until the next starts.
  let progress: Progress | undefined

  const start = (
    request: { readonly argv: ReadonlyArray<string>; readonly cwd: string },
    onLine: (line: string) => void,
  ): Promise<RunResult> => {
    if (current !== undefined) return Promise.reject(new Error("a review is already running in this session"))
    let stdout = ""
    let stderr = ""
    let pending = ""
    const startedAt = Date.now()
    const shown: Progress = {
      argv: request.argv,
      runId: undefined,
      startedAt,
      endedAt: undefined,
      lenses: [],
      findersFinished: false,
      routed: undefined,
      latest: undefined,
      exitCode: undefined,
      result: undefined,
      refusal: undefined,
    }
    progress = shown
    const onStderr = (text: string) => {
      stderr += text
      pending += text
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        if (!/^gauntlet: (invoking|loading|run \S+$)/.test(line)) shown.latest = line
        onLine(line)
      }
    }
    const onMilestone = (milestone: RunMilestone) =>
      Effect.sync(() => {
        switch (milestone._tag) {
          case "Started": {
            shown.runId = milestone.runId
            shown.lenses = milestone.lenses
            if (current !== undefined) current.runId = milestone.runId
            return
          }
          case "FindersFinished": {
            shown.findersFinished = true
            return
          }
          case "Routed": {
            shown.routed = { bugClaims: milestone.bugClaims, observations: milestone.observations }
            return
          }
          case "Reviewed": {
            shown.result = milestone
            return
          }
          case "Refused": {
            shown.refusal = milestone.message
          }
        }
      })
    const host = makeClaudeHost(claudePrice((model) => build.prices[model]), driver.send)
    driver.attach(host)
    const layer = Layer.mergeAll(
      Layer.succeed(HarnessSessionFactory, host.factory),
      Linear.Default,
      liveGitHubLayer,
    ).pipe(
      Layer.provideMerge(
        platformLayer({
          ...ports,
          stdout: (text) => {
            stdout += text
          },
          stderr: onStderr,
        }),
      ),
    )
    const program = runReviewCli(request.argv).pipe(
      Effect.provideService(RunMilestones, onMilestone),
      Effect.provideService(InvocationDirectory, request.cwd),
      Effect.provideService(FetchHttpClient.Fetch, fetchOver(ports)),
      Effect.provide(layer),
      // A Layer that cannot be built (a Config read) is a review that could
      // not run, rendered as the CLI renders its failures.
      Effect.catch((failure) =>
        Effect.sync(() => {
          const message = `could not review — ${String(failure)}`
          onStderr(`gauntlet: ${message}\n`)
          shown.refusal = message
          return 1
        })
      ),
    )
    const fiber = Effect.runFork(program)
    current = { fiber, startedAt, argv: request.argv, runId: undefined }
    return new Promise((resolve) => {
      fiber.addObserver((exit) => {
        current = undefined
        void driver.stopAll("run ended")
        progress = {
          ...shown,
          endedAt: Date.now(),
          exitCode: Exit.isSuccess(exit) ? exit.value : 1,
          latest: shown.result === undefined ? shown.latest : `Result: ${resultCounts(shown.result)}`,
        }
        resolve({
          exitCode: Exit.isSuccess(exit) ? exit.value : 1,
          refusal: shown.refusal,
          stdout,
          stderr: `${stderr}${Exit.isSuccess(exit) ? "" : `gauntlet: run ended: ${String(exit.cause)}\n`}`,
          seconds: Math.round((Date.now() - startedAt) / 1000),
          interrupted: Exit.isFailure(exit),
        })
      })
    })
  }

  // Interrupting the fiber runs the program's finalizers: the snapshot
  // worktree is removed and every live agent is stopped.
  const cancel = () => {
    if (current === undefined) return Promise.resolve(false)
    return Effect.runPromise(Fiber.interrupt(current.fiber)).then(() => true)
  }

  const turnComplete = (e: TurnComplete) => driver.turnComplete(e)

  return {
    start,
    cancel,
    turnComplete,
    poll: driver.poll,
    isOffering: driver.isOffering,
    running: () =>
      current === undefined
        ? undefined
        : {
          runId: current.runId,
          startedAt: current.startedAt,
          argv: current.argv,
          agentIds: driver.agentIds(),
          snapshots: driver.snapshots(),
        },
    stats: driver.stats,
    view: (): RunView | undefined =>
      progress === undefined
        ? undefined
        : {
          ...progress,
          activity: driver.activity(),
        },
  }
}

export type Engine = ReturnType<typeof createEngine>
