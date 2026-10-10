// The Mod's engine (#134 Idea 3): the Gauntlet review program itself, run
// in process inside Claude Code. `bun run build-mod` bundles this entry,
// Effect included, into the plugin's hooks/vendor/engine.js; the hooks
// module (mod/gauntlet/hooks/register.ts) hands it ports over `$` and relays
// the hooks' observations; the session policy around its runs is
// mod/session.ts. There is no second pipeline: the typed words go to
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
import type { Json } from "effect/Schema"
import * as CliConfig from "effect/cli/CliConfig"
import * as Command from "effect/cli/Command"
import * as GlobalFlag from "effect/cli/GlobalFlag"
import { printConfiguration } from "../src/cli/config.ts"
import { isFreshConfig, writeInitialConfig } from "../src/config/initial-config.ts"
import { availableRecipeNames, listRecipes } from "../src/config/recipe-catalog.ts"
import { ConfigHost } from "../src/config/settings.ts"
import { standardsManifestPath } from "../src/config/standards-manifest.ts"
import { liveGitHubLayer } from "../src/github/github.ts"
import { makeClaudeLiveFactory } from "../src/harness/claude-live.ts"
import { HarnessSessionFactory } from "../src/harness/harness-session.ts"
import { Linear } from "../src/linear/linear.ts"
import * as Run from "../src/run/run.ts"
import { type RunMilestone, RunMilestones } from "../src/run/run-milestones.ts"
import { type Destination, reviewSyntax } from "../src/syntax/syntax.ts"
import { InvocationDirectory } from "../src/target/invocation-directory.ts"
import { type AgentActivity, makeActivity } from "./activity.ts"
import { playDemo } from "./demo.ts"
import { platformLayer, type PlatformPorts } from "./platform.ts"
import type { RunView } from "./strip.ts"

export { renderStrip } from "./strip.ts"
export type { PaneElements, RunView } from "./strip.ts"
export { reviewToolArgs, reviewToolInputSchema } from "./review-argv.ts"
export { BUILD_FILE, createSession, recoverLostRun } from "./session.ts"
export type { Session } from "./session.ts"
export type { Json } from "effect/Schema"

// What `bun run build-mod` writes beside the bundle as vendor/build.json.
export interface BuildInfo {
  readonly stamp: string
  readonly files: number
  readonly repoRoot: string
  readonly builtAt: string
  // The bun that built it, which rebuilds it.
  readonly bun: string
}

export interface HttpPort {
  readonly fetch: (
    url: string,
    init: { readonly method: string; readonly headers: Record<string, string>; readonly body?: string },
  ) => Promise<{ readonly status: number; readonly headers: Record<string, string>; readonly text: string }>
}

export interface EnginePorts extends PlatformPorts, HttpPort {
  // The mod's log, ~/.gauntlet/mod/mod.log.
  readonly log: (line: string) => void
  // The plugin's key-value store of JSON data, kept across sessions and
  // reloads.
  readonly store: {
    readonly get: (key: string) => Promise<Json | undefined>
    readonly set: (key: string, value: Json) => Promise<void>
    readonly delete: (key: string) => Promise<void>
  }
  readonly toast: (text: string, options?: { readonly timeoutMs?: number }) => void
  readonly status: (text: string | undefined) => void
  // The Caller. `send` messages a subagent and `submit` prompts the main
  // agent, each answering why it did not land, if it did not; `append` adds a
  // user row to the main agent's conversation.
  readonly send: (agentId: string, text: string) => Promise<string | undefined>
  readonly submit: (text: string) => Promise<string | undefined>
  readonly append: (text: string) => Promise<void>
}

// How a run ended, in the Mod's words.
export interface RunResult {
  // A few words for the message's heading.
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
  // A pull-request review's digest, as soon as the review has it and before
  // its post starts; undefined for a run with no post to follow. A run that
  // has one ends with the post's outcome alone.
  readonly reviewed: Promise<RunResult | undefined>
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

// The strip's view less the invocations' activity.
type Progress = {
  -readonly [K in Exclude<keyof RunView, "activity">]: RunView[K]
}

export const createEngine = (ports: EnginePorts, build: BuildInfo) => {
  let current:
    | {
      readonly fiber: Fiber.Fiber<void>
      readonly startedAt: number
      readonly argv: ReadonlyArray<string>
      runId: string | undefined
      snapshot: string | undefined
    }
    | undefined
  // What the strip draws: the review in flight, or the last one, kept until
  // the next starts, with its invocations' activity.
  let progress: Progress | undefined
  let activity: () => ReadonlyArray<AgentActivity> = () => []

  // One run at a time: the hooks module admits a session's one review before
  // it starts.
  const start = (
    request: { readonly words: ReadonlyArray<string>; readonly cwd: string },
    onLine: (line: string) => void,
  ): StartedRun => {
    const delivering = request.words[0] === "deliver"
    const watched = makeActivity()
    // Kept past the run's end: the last invocations' transcripts move into
    // it as their children exit.
    let runDirectory: string | undefined
    let printed = ""
    let pending = ""
    let answer: Omit<RunResult, "seconds"> | undefined
    const startedAt = Date.now()
    const elapsed = () => Math.round((Date.now() - startedAt) / 1000)
    const shown: Progress = {
      startedAt,
      endedAt: undefined,
      lenses: [],
      skipped: [],
      findersFinished: false,
      routed: undefined,
      exitCode: undefined,
      result: undefined,
      refusal: undefined,
      post: undefined,
    }
    let parsed: (review: Run.ReviewRequest | undefined) => void = () => undefined
    const reviewRequest = new Promise<Run.ReviewRequest | undefined>((resolve) => {
      parsed = resolve
    })
    let posting: (result: RunResult | undefined) => void = () => undefined
    const reviewed = new Promise<RunResult | undefined>((resolve) => {
      posting = resolve
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
            shown.skipped = milestone.skipped
            runDirectory = milestone.directory
            if (current !== undefined) current.runId = milestone.runId
            return
          }
          case "SnapshotDirectoryMade": {
            if (current !== undefined) current.snapshot = milestone.directory
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
    // A review the words asked for, from the strip's first draw to its
    // answer, run by the Run module or the demo's stand-in for it. Only words
    // that became a review draw the strip: help, a delivery and words that
    // never parsed leave it to the last review.
    // A pull-request destination hands off the digest before it delivers the
    // Run, so a slow or hung post never withholds it: the post's receipt or
    // refusal is the run's answer, and a run cancelled while posting has shown
    // its digest already.
    const reviewing = <E, R, R2>(
      review: Run.ReviewRequest,
      destination: Destination,
      run: {
        readonly review: Effect.Effect<{ readonly runId: string; readonly digest: string }, E, R>
        readonly deliver: (runId: string) => Effect.Effect<{ readonly url: string }, Run.RunRefusal, R2>
        readonly activity: () => ReadonlyArray<AgentActivity>
      },
    ) =>
      Effect.sync(() => {
        progress = shown
        activity = run.activity
        parsed(review)
      }).pipe(
        Effect.andThen(run.review),
        Effect.flatMap((reviewed) =>
          destination === "local"
            ? Effect.sync(() => {
              answer = { verdict: "review finished", digest: reviewed.digest, notes: [] }
            })
            : Effect.sync(() => {
              shown.post = { state: "posting", text: "posting to the pull request" }
              posting({ verdict: "review finished", digest: reviewed.digest, notes: [], seconds: elapsed() })
            }).pipe(
              Effect.andThen(run.deliver(reviewed.runId)),
              Effect.match({
                onSuccess: (receipt) => ({ verdict: "delivered", notes: [`posted ${receipt.url}`], state: "posted" as const }),
                onFailure: (refusal) => ({ verdict: "could not deliver", notes: [refusalText(refusal)], state: "failed" as const }),
              }),
              Effect.map(({ verdict, notes, state }) => {
                shown.post = { state, text: notes.join("; ") }
                answer = { verdict, digest: "", notes }
              }),
            )
        ),
      )
    const gauntlet = Command.make("gauntlet").pipe(
      Command.withSubcommands(reviewSyntax({ relatedFiles: true }, {
        review: (review, destination) =>
          reviewing(review, destination, { review: Run.review(review), deliver: Run.deliver, activity: watched.activity }),
        deliver: (runId) =>
          Run.deliver(runId).pipe(
            Effect.map((receipt) => {
              answer = { verdict: "delivered", digest: "", notes: [`posted ${receipt.url}`] }
            }),
          ),
      })),
    )
    // Each invocation is a `claude -p` child of this Claude Code (#181),
    // watched for the strip.
    const factory = Layer.effect(
      HarnessSessionFactory,
      makeClaudeLiveFactory({
        executable: "claude",
        runDirectory: () => runDirectory,
      }).pipe(Effect.map(watched.watch)),
    )
    const layer = Layer.mergeAll(
      factory,
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
    // `demo` plays a scripted review (mod/demo.ts) where the CLI's words
    // would run one.
    const program = Effect.suspend(() =>
      request.words[0] === "demo"
        ? playDemo(request.words.slice(1), request.cwd).pipe(
          Effect.flatMap((demo) => reviewing(demo.review, demo.destination, demo.run)),
        )
        : Command.runWith(gauntlet, { version: build.stamp.slice(0, 12) })(request.words)
    ).pipe(
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
      // The CLI's other global flags (--version, --wizard, --completions,
      // --log-level) mean nothing in Claude Code: the Mod keeps only --help.
      Effect.provideService(CliConfig.CliConfig, CliConfig.make({ builtIns: [GlobalFlag.Help] })),
      Effect.provideService(RunMilestones, onMilestone),
      Effect.provideService(InvocationDirectory, request.cwd),
      Effect.provideService(ConfigHost, "mod"),
      Effect.provideService(FetchHttpClient.Fetch, fetchOver(ports)),
      Effect.provide(layer),
      // A Layer that cannot be built (a Config read) is a review that could
      // not run.
      Effect.catch((failure) => refuse(`could not review — ${String(failure)}`)),
    )
    const fiber = Effect.runFork(program)
    current = { fiber, startedAt, argv: request.words, runId: undefined, snapshot: undefined }
    const ended = new Promise<RunResult>((resolve) => {
      fiber.addObserver((exit) => {
        current = undefined
        parsed(undefined)
        posting(undefined)
        const failed = Exit.isFailure(exit)
        // A post cut short, by a stop or a defect, may still have landed.
        if (Exit.isFailure(exit) && shown.post?.state === "posting") {
          const cut = Cause.hasInterruptsOnly(exit.cause) ? "post interrupted" : defectText(exit.cause)
          shown.post = { state: "failed", text: `${cut}; check the pull request for the comment` }
        }
        if (progress === shown) {
          progress = { ...shown, endedAt: Date.now(), exitCode: failed || shown.refusal !== undefined ? 1 : 0 }
        }
        const seconds = elapsed()
        if (Exit.isFailure(exit)) {
          const cancelled = Cause.hasInterruptsOnly(exit.cause)
          // Only a local review interrupted as it finished has a digest
          // here; one that was posting has handed its digest off.
          resolve({
            verdict: cancelled ? "cancelled" : "run ended",
            digest: answer?.digest ?? "",
            notes: cancelled ? [] : [defectText(exit.cause)],
            seconds,
          })
        } else resolve({ ...(answer ?? { verdict: "help", digest: printed.trim(), notes: [] }), seconds })
      })
    })
    return { request: reviewRequest, reviewed, ended }
  }

  // Interrupting the fiber runs the program's finalizers: the snapshot
  // worktree is removed and every invocation's child is killed.
  const cancel = () => {
    if (current === undefined) return Promise.resolve(false)
    return Effect.runPromise(Fiber.interrupt(current.fiber)).then(() => true)
  }

  // The names of the Mod's valid Recipes, its configuration written first
  // when the Mod finds none (#177).
  const recipes = (): Promise<ReadonlyArray<string>> =>
    Effect.gen(function* () {
      if (yield* isFreshConfig()) yield* writeInitialConfig()
      return availableRecipeNames(yield* listRecipes())
    }).pipe(Effect.provideService(ConfigHost, "mod"), Effect.provide(platformLayer(ports)), Effect.runPromise)

  // `/gauntlet config`: the CLI's bare config listing over the Mod's own
  // settings and catalog, answered at once; it starts no run. Settings change
  // by editing the Mod's files, so its other words only get that pointer.
  const config = (request: { readonly words: ReadonlyArray<string>; readonly cwd: string }): Promise<string> => {
    let printed = ""
    return printConfiguration().pipe(
      Effect.as(""),
      Effect.catch((failure) => Effect.succeed(`could not list the configuration — ${String(failure)}`)),
      Effect.provideService(InvocationDirectory, request.cwd),
      Effect.provideService(ConfigHost, "mod"),
      Effect.provide(platformLayer({ ...ports, stdout: (text) => {
        printed += text
      } })),
      Effect.map((failed) =>
        [
          request.words.length > 1 ? "/gauntlet config only lists; edit ~/.gauntlet/mod/settings.json or its recipes/ to change them." : "",
          printed.trim(),
          failed,
        ].filter((text) => text !== "").join("\n")
      ),
      Effect.runPromise,
    )
  }

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
    recipes,
    config,
    standardsManifest,
    running: () =>
      current === undefined
        ? undefined
        : {
          runId: current.runId,
          startedAt: current.startedAt,
          argv: current.argv,
          snapshots: current.snapshot === undefined ? [] : [current.snapshot],
        },
    view: (): RunView | undefined =>
      progress === undefined
        ? undefined
        : {
          ...progress,
          activity: activity(),
        },
  }
}

export type Engine = ReturnType<typeof createEngine>
