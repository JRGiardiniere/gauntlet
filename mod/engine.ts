// The Mod's engine (#134 Idea 3): the Gauntlet review program itself, run
// in process inside Claude Code. `bun run build-mod` bundles this entry,
// Effect included, into the plugin's hooks/vendor/engine.js; the hooks
// module (mod/gauntlet/hooks/register.ts) hands it ports over `$` and relays
// the hooks' observations. There is no second pipeline: the typed words go to
// the syntax the CLI parses too (src/syntax/syntax.ts), and the request to
// the Run module (src/run/run.ts), which runs Submission, the snapshot
// worktree, invoke.ts deadlines and corrective turns, the Stages and the run
// record exactly as the CLI's review does. Only the platform services, the
// HarnessSession adapter and the wording of what comes back differ.
import * as Cause from "effect/Cause"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Fiber from "effect/Fiber"
import * as FileSystem from "effect/FileSystem"
import * as FetchHttpClient from "effect/http/FetchHttpClient"
import * as Layer from "effect/Layer"
import * as Result from "effect/Result"
import * as Command from "effect/cli/Command"
import { listRecipes } from "../src/config/recipe-catalog.ts"
import { standardsManifestPath } from "../src/config/standards-manifest.ts"
import { isClaudeCodeSeat } from "../src/domain/recipe.ts"
import { liveGitHubLayer } from "../src/github/github.ts"
import {
  type ClaudeModelCost,
  claudePrice,
  makeClaudeHost,
} from "../src/harness/claude-host.ts"
import { HarnessSessionFactory } from "../src/harness/harness-session.ts"
import { Linear } from "../src/linear/linear.ts"
import * as Run from "../src/run/run.ts"
import { type RunMilestone, RunMilestones } from "../src/run/run-milestones.ts"
import { reviewSyntax } from "../src/syntax/syntax.ts"
import { InvocationDirectory } from "../src/target/invocation-directory.ts"
import { type AgentPorts, makeAgentDriver, type TurnComplete } from "./agents.ts"
import { platformLayer, type PlatformPorts } from "./platform.ts"
import type { RunView } from "./strip.ts"

export { renderStrip } from "./strip.ts"
export type { PaneElements, RunView } from "./strip.ts"
export { commandWords, reviewToolArgs, reviewToolInputSchema } from "./review-argv.ts"
export type { ReviewRequest } from "../src/run/run.ts"
export { releaseNotice } from "./release-update.ts"
export { digestDelivery } from "./digest-delivery.ts"
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

// How a run ended, in the Mod's words.
export interface RunResult {
  // A few words for the toast and the message's heading.
  readonly verdict: string
  // The digest, or the help the words asked for; empty when there is neither.
  readonly digest: string
  // Where the Dossier was posted, why the review or the post could not
  // happen, or what ended a run that reached no answer.
  readonly notes: ReadonlyArray<string>
  readonly seconds: number
}

export interface StartedRun {
  // The review the words asked for, once they parse; undefined for a
  // delivery, or for words that never became a review.
  readonly request: Promise<Run.ReviewRequest | undefined>
  readonly ended: Promise<RunResult>
}

// An error's own words: its message, or a tagged error's fields (git's
// stderr on a GitCommandError) when it has none.
const errorText = (error: Error) =>
  error.message === ""
    ? `${error.name} ${JSON.stringify(Object.fromEntries(Object.entries(error).filter(([key]) => key !== "cause" && key !== "_tag")))}`
    : `${error.name}: ${error.message}`

const defectText = (cause: Cause.Cause<unknown>) => {
  const defect = Cause.squash(cause)
  return `run ended: ${defect instanceof Error ? errorText(defect) : String(defect)}`
}

// A refusal as the Mod words it: a post that may have landed names the
// command that delivers the Run again.
const refusalText = (refusal: Run.RunRefusal) =>
  refusal.unconfirmedPost !== undefined
    ? `${refusal.reason}; check the pull request for the comment before /gauntlet deliver ${refusal.unconfirmedPost}`
    : refusal.unconfigured === true
    ? `${refusal.reason}; set up Gauntlet's recipes and settings as its INSTALL.md says`
    : refusal.reason

const deliveryNotes = (reviewed: Run.Reviewed): ReadonlyArray<string> => {
  if (reviewed.delivery === undefined) return []
  return Result.isSuccess(reviewed.delivery)
    ? [`posted ${reviewed.delivery.success.url}`]
    : [refusalText(reviewed.delivery.failure)]
}

// The mod has no global fetch; Linear's FetchHttpClient gets this one over
// `$.http.fetch`. FetchHttpClient calls it with a URL, a method, a header
// record and a Uint8Array or string body, and reads only status, url,
// headers and arrayBuffer() of the answer (HttpClientResponse.fromWeb).
// A request cannot be cancelled: `$.http.fetch` takes no AbortSignal, so an
// interrupted run stops waiting while the request runs on to its end.
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

// The strip's view less the driver's activity.
type Progress = {
  -readonly [K in Exclude<keyof RunView, "activity">]: RunView[K]
}

export const createEngine = (ports: EnginePorts, build: BuildInfo) => {
  const driver = makeAgentDriver(ports)
  let current:
    | {
      readonly fiber: Fiber.Fiber<void>
      readonly startedAt: number
      readonly argv: ReadonlyArray<string>
      runId: string | undefined
    }
    | undefined
  // What the strip draws: the review in flight, or the last one, kept until
  // the next starts.
  let progress: Progress | undefined

  const start = (
    request: { readonly words: ReadonlyArray<string>; readonly cwd: string },
    onLine: (line: string) => void,
  ): StartedRun => {
    if (current !== undefined) throw new Error("a review is already running in this session")
    const delivering = request.words[0] === "deliver"
    let printed = ""
    let pending = ""
    let answer: Omit<RunResult, "seconds"> | undefined
    const startedAt = Date.now()
    const shown: Progress = {
      startedAt,
      endedAt: undefined,
      lenses: [],
      findersFinished: false,
      routed: undefined,
      exitCode: undefined,
      result: undefined,
      refusal: undefined,
    }
    let parsed: (review: Run.ReviewRequest | undefined) => void = () => undefined
    const reviewRequest = new Promise<Run.ReviewRequest | undefined>((resolve) => {
      parsed = resolve
    })
    // Progress lines go to the mod's log only; nothing reads meaning in them.
    const onStderr = (text: string) => {
      pending += text
      const lines = pending.split("\n")
      pending = lines.pop() ?? ""
      for (const line of lines) onLine(line)
    }
    const onMilestone = (milestone: RunMilestone) =>
      Effect.sync(() => {
        switch (milestone._tag) {
          case "Started": {
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
          }
        }
      })
    const refuse = (reason: string) =>
      Effect.sync(() => {
        shown.refusal = reason
        answer = { verdict: delivering ? "could not deliver" : "could not review", digest: "", notes: [reason] }
      })
    const gauntlet = Command.make("gauntlet").pipe(
      Command.withSubcommands(reviewSyntax({ relatedFiles: true }, {
        // Only words that became a review draw the strip: help, a delivery
        // and words that never parsed leave it to the last review.
        review: (review) =>
          Effect.sync(() => {
            progress = shown
            parsed(review)
          }).pipe(
            Effect.andThen(Run.review(review)),
            Effect.map((reviewed) => {
              answer = { verdict: "review finished", digest: reviewed.digest, notes: deliveryNotes(reviewed) }
            }),
          ),
        deliver: (runId) =>
          Run.deliver(runId).pipe(
            Effect.map((receipt) => {
              answer = { verdict: "delivered", digest: "", notes: [`posted ${receipt.url}`] }
            }),
          ),
      })),
    )
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
            printed += text
          },
          stderr: onStderr,
        }),
      ),
    )
    const program = Command.runWith(gauntlet, { version: build.stamp.slice(0, 12) })(request.words).pipe(
      Effect.catchTags({
        // Help asked for is printed; help shown for words that did not parse
        // carries why.
        ShowHelp: (help) =>
          help.errors.length === 0
            ? Effect.void
            : refuse(`${help.errors.map((error) => error.message).join("; ")}; /gauntlet --help shows the syntax`),
        ReviewCommandError: (failure) => refuse(`could not review — ${failure.reason}`),
        RunRefusal: (refusal) => refuse(refusalText(refusal)),
      }),
      Effect.provideService(RunMilestones, onMilestone),
      Effect.provideService(InvocationDirectory, request.cwd),
      Effect.provideService(FetchHttpClient.Fetch, fetchOver(ports)),
      Effect.provide(layer),
      // A Layer that cannot be built (a Config read) is a review that could
      // not run.
      Effect.catch((failure) => refuse(`could not review — ${String(failure)}`)),
    )
    const fiber = Effect.runFork(program)
    current = { fiber, startedAt, argv: request.words, runId: undefined }
    const ended = new Promise<RunResult>((resolve) => {
      fiber.addObserver((exit) => {
        current = undefined
        parsed(undefined)
        void driver.stopAll("run ended")
        const failed = Exit.isFailure(exit)
        if (progress === shown) {
          progress = { ...shown, endedAt: Date.now(), exitCode: failed || shown.refusal !== undefined ? 1 : 0 }
        }
        const seconds = Math.round((Date.now() - startedAt) / 1000)
        if (Exit.isFailure(exit)) {
          const cancelled = Cause.hasInterruptsOnly(exit.cause)
          resolve({ verdict: cancelled ? "cancelled" : "run ended", digest: "", notes: cancelled ? [] : [defectText(exit.cause)], seconds })
        } else resolve({ ...(answer ?? { verdict: "help", digest: printed.trim(), notes: [] }), seconds })
      })
    })
    return { request: reviewRequest, ended }
  }

  // Interrupting the fiber runs the program's finalizers: the snapshot
  // worktree is removed and every live agent is stopped.
  const cancel = () => {
    if (current === undefined) return Promise.resolve(false)
    return Effect.runPromise(Fiber.interrupt(current.fiber)).then(() => true)
  }

  const turnComplete = (e: TurnComplete) => driver.turnComplete(e)

  // The catalog's valid Recipes this Host can run: every Seat claude-code/.
  const claudeRecipes = (): Promise<ReadonlyArray<string>> =>
    listRecipes().pipe(
      Effect.map((entries) =>
        entries.flatMap((entry) =>
          entry._tag === "ValidRecipe" && Object.values(entry.recipe).every(isClaudeCodeSeat) ? [entry.name] : []
        )
      ),
      Effect.provide(platformLayer(ports)),
      Effect.runPromise,
    )

  // Where this repository's Standards Manifest goes, and whether it is there:
  // an empty one is the person's "no standards here", and the lens skips it.
  const standardsManifest = (repoRoot: string) =>
    Effect.gen(function* () {
      const path = yield* standardsManifestPath(repoRoot)
      const exists = yield* (yield* FileSystem.FileSystem).exists(path)
      return { path, exists }
    }).pipe(Effect.withSpan("Standards.manifestStatus"), Effect.provide(platformLayer(ports)), Effect.runPromise)

  return {
    start,
    cancel,
    claudeRecipes,
    standardsManifest,
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
