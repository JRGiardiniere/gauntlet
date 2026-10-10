import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as PlatformError from "effect/PlatformError"
import * as Sink from "effect/Sink"
import * as Stream from "effect/Stream"
import type * as ChildProcess from "effect/process/ChildProcess"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { Termination } from "../domain/agent-outcome.ts"
import { makeClaudeLiveFactory } from "./claude-live.ts"
import { HarnessSessionFactory } from "./harness-session.ts"
import { invoke, type InvokeInput } from "./invoke.ts"
import { EmitFindings, type FindingsOutput } from "./output-contract.ts"

// The adapter at the HarnessSession seam, under invoke.ts: a scripted
// ChildProcessSpawner replays `claude -p` stream-json recorded from Claude
// Code 2.1.296 (fixtures/claude-p, trimmed). refusal.jsonl is no-emit.jsonl's
// first response with its stop reason set to `refusal`, which no prompt
// reliably provokes.

const fixture = (name: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    return yield* fs.readFileString(path.join(import.meta.dirname, "fixtures", "claude-p", `${name}.jsonl`))
  })

// How a scripted child ends after its stream: an exit code, or a signal the
// run did not send.
interface Child {
  readonly stdout: string
  readonly ending: number | "signal"
}

interface Spawned {
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly cwd: string | undefined
  readonly env: Record<string, string | undefined> | undefined
  readonly stdin: string
}

const stdinOf = (command: ChildProcess.StandardCommand) => {
  const input = command.options.stdin
  return Stream.isStream(input)
    ? Stream.mkString(Stream.decodeText(input))
    : Effect.succeed("")
}

const scriptedSpawner = (children: Array<Child>, spawned: Array<Spawned>) =>
  ChildProcessSpawner.make((command) =>
    Effect.gen(function* () {
      if (command._tag !== "StandardCommand") return yield* Effect.die("a piped command")
      const child = children.shift()
      if (child === undefined) return yield* Effect.die("no scripted child left")
      spawned.push({
        command: command.command,
        args: command.args,
        cwd: command.options.cwd,
        env: command.options.env,
        stdin: yield* stdinOf(command),
      })
      return ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: child.ending === "signal"
          ? Effect.fail(PlatformError.systemError({ _tag: "Unknown", module: "ChildProcess", method: "spawn", description: "SIGTERM" }))
          : Effect.succeed(ChildProcessSpawner.ExitCode(child.ending)),
        isRunning: Effect.succeed(false),
        kill: () => Effect.void,
        stdin: Sink.drain,
        stdout: Stream.make(new TextEncoder().encode(child.stdout)),
        stderr: Stream.empty,
        all: Stream.empty,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      })
    })
  )

const input = (cwd: string): InvokeInput<FindingsOutput> => ({
  invocationId: "fixture-run-finders-1-finder-fixture-lens",
  seat: "claude-code/haiku:low",
  cwd,
  systemPrompt: "finder system prompt",
  prompt: "review this diff",
  contract: EmitFindings,
  tools: ["read"],
  deadlines: {
    overallMillis: 600_000,
    startupMillis: 60_000,
    firstResponseMillis: 60_000,
    toolMillis: 60_000,
    bashMillis: 60_000,
  },
})

// Invokes once over the scripted children, in a snapshot under a real
// temporary Run temp area.
const invokeOver = (...names: ReadonlyArray<readonly [string, number | "signal"]>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const children = yield* Effect.forEach(names, ([name, ending]) =>
      Effect.map(fixture(name), (stdout): Child => ({ stdout, ending })))
    const spawned: Array<Spawned> = []
    const temp = yield* fs.makeTempDirectoryScoped({ prefix: "gauntlet-claude-live-" })
    const cwd = `${temp}/worktree`
    yield* fs.makeDirectory(cwd)
    const factory = yield* makeClaudeLiveFactory({ executable: "/fixture/bin/claude", runDirectory: () => undefined }).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, scriptedSpawner(children, spawned)),
    )
    const outcome = yield* invoke(input(cwd)).pipe(Effect.provideService(HarnessSessionFactory, factory))
    return { outcome, spawned, cwd }
  }).pipe(Effect.provide(NodeServices.layer))

const FENCE = [
  ["--tools", "Read,Grep,Glob"],
  ["--permission-mode", "default"],
  ["--permission-prompts", "none"],
  ["--setting-sources", ""],
] as const

const hasPair = (args: ReadonlyArray<string>, [flag, value]: readonly [string, string]) =>
  args.some((arg, at) => arg === flag && args[at + 1] === value)

describe("the Claude Code Host's claude -p adapter", () => {
  it.effect("completes on the result's structured output, counting its tool calls and the turn's cost", () =>
    Effect.gen(function* () {
      const { cwd, outcome, spawned } = yield* invokeOver(["emit", 0])

      expect(Termination.guards.Completed(outcome.termination)).toBe(true)
      expect(outcome.output?.findings[0]?.file).toBe("avg.ts")
      expect(outcome.toolCalls).toEqual({ total: 2, errored: 0 })
      expect(outcome.usage.rawRows).toHaveLength(3)
      expect(outcome.usage.costUsd).toBeCloseTo(0.00132017, 8)
      expect(spawned[0]).toMatchObject({ command: "/fixture/bin/claude", cwd, stdin: "review this diff" })
    }))

  it.effect("resumes the session for a corrective turn when the result has no structured output, with the same fence and isolation", () =>
    Effect.gen(function* () {
      const { outcome, spawned } = yield* invokeOver(["no-emit", 0], ["corrective", 0])

      expect(Termination.guards.Completed(outcome.termination)).toBe(true)
      expect(outcome.diagnostics).toContain("validated emit succeeded after 1 corrective turn")
      const [first, second] = spawned
      expect(second?.stdin).toContain("Call StructuredOutput now")
      const sessionId = first?.args[first.args.indexOf("--session-id") + 1]
      expect(second?.args).toEqual(first?.args.map((arg) => (arg === "--session-id" ? "--resume" : arg)))
      expect(second?.args).toContain(sessionId)
      for (const turn of [first, second]) {
        for (const pair of FENCE) expect(hasPair(turn?.args ?? [], pair)).toBe(true)
        expect(turn?.args).toContain("--strict-mcp-config")
        expect(turn?.env).toMatchObject({ CLAUDE_CODE_PLUGIN_DIRS: "", CLAUDE_CODE_CHILD_SESSION: undefined })
      }
      // The two turns' costs: each on its turn's last response.
      expect(outcome.usage.costUsd).toBeCloseTo(0.00029465 + 0.00160743, 8)
    }))

  it.effect("ends at the context limit when the turn's last response hit max_tokens, though its result is an error", () =>
    Effect.gen(function* () {
      const { outcome } = yield* invokeOver(["max-tokens", 1])

      expect(Termination.guards.ContextLimit(outcome.termination)).toBe(true)
    }))

  it.effect("ends a refused response as a provider failure", () =>
    Effect.gen(function* () {
      const { outcome } = yield* invokeOver(["refusal", 0])

      expect(Termination.guards.ProviderFailed(outcome.termination)).toBe(true)
      expect(outcome.diagnostics).toContain("provider failed: Claude stop reason refusal")
    }))

  it.effect("ends a child killed before its result as interrupted, its unfinished turn costing nothing", () =>
    Effect.gen(function* () {
      const { outcome } = yield* invokeOver(["killed", "signal"])

      expect(Termination.guards.Interrupted(outcome.termination)).toBe(true)
      expect(outcome.usage.rawRows).toHaveLength(1)
      expect(outcome.usage.costUsd).toBe(0)
    }))
})
