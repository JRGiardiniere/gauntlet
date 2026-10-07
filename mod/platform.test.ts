import type { ProcessSpawnChunk, ProcessSpawnResult } from "claude-code"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import * as ChildProcess from "effect/process/ChildProcess"
import { ChildProcessSpawner } from "effect/process/ChildProcessSpawner"
import { describe, expect, it } from "vitest"
import { platformLayer, type PlatformPorts } from "./platform.ts"

const unused = () => Promise.reject(new Error("not used by this test"))

// A child that wrote one piece and never ends, as a hung git does; leaving
// its loop is how `$.process.spawn` kills it.
const hungChild = () => {
  const child = { started: Promise.withResolvers<void>(), killed: false }
  const pieces: AsyncIterable<ProcessSpawnChunk, ProcessSpawnResult> = {
    [Symbol.asyncIterator]: () => {
      let pulls = 0
      return {
        next: () => {
          pulls += 1
          if (pulls === 1) {
            child.started.resolve()
            return Promise.resolve({ done: false, value: { stream: "stdout", text: "partial" } })
          }
          return new Promise(() => {})
        },
        return: () => {
          child.killed = true
          return Promise.resolve({ done: true, value: { code: null, signal: "SIGTERM" } })
        },
      }
    },
  }
  return { child, pieces }
}

describe("the mod's child processes", () => {
  it("kills a running child when the run is interrupted", async () => {
    const { child, pieces } = hungChild()
    const ports: PlatformPorts = {
      read: unused,
      readBytes: unused,
      write: unused,
      list: unused,
      exists: unused,
      stat: unused,
      run: unused,
      spawnProcess: () => pieces,
      env: {},
      stdout: () => undefined,
      stderr: () => undefined,
    }
    const fiber = Effect.runFork(
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner
        return yield* spawner.string(ChildProcess.make("git", ["diff"]))
      }).pipe(Effect.provide(platformLayer(ports))),
    )
    await child.started.promise

    await Effect.runPromise(Fiber.interrupt(fiber))

    expect(child.killed).toBe(true)
  })
})
