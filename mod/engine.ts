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
import { InvocationDirectory } from "../src/target/invocation-directory.ts"
import { type AgentPorts, makeAgentDriver, type TurnComplete } from "./agents.ts"
import { platformLayer, type PlatformPorts } from "./platform.ts"

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

  const start = (
    request: { readonly argv: ReadonlyArray<string>; readonly cwd: string },
    onLine: (line: string) => void,
  ): Promise<RunResult> => {
    if (current !== undefined) return Promise.reject(new Error("a review is already running in this session"))
    let stdout = ""
    let stderr = ""
    let pending = ""
    const startedAt = Date.now()
    const onStderr = (text: string) => {
      stderr += text
      pending += text
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) {
        const id = /^gauntlet: run (\S+)$/.exec(line)?.[1]
        if (id !== undefined && current !== undefined) current.runId = id
        onLine(line)
      }
    }
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
      Effect.provideService(InvocationDirectory, request.cwd),
      Effect.provideService(FetchHttpClient.Fetch, fetchOver(ports)),
      Effect.provide(layer),
      // A Layer that cannot be built (a Config read) is a review that could
      // not run, rendered as the CLI renders its failures.
      Effect.catch((failure) =>
        Effect.sync(() => {
          onStderr(`gauntlet: could not review — ${String(failure)}\n`)
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
        resolve({
          exitCode: Exit.isSuccess(exit) ? exit.value : 1,
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
  }
}

export type Engine = ReturnType<typeof createEngine>
