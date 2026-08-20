#!/usr/bin/env bun
// The single runMain boundary. Everything below stays Effect-native; the
// exit-code contract is decided inside runGauntlet before this crossing.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { runGauntlet } from "../src/cli/main.ts"
import { liveGitHubLayer } from "../src/github/github.ts"
import { livePiLayer } from "../src/harness/pi-live.ts"
import { Linear } from "../src/linear/linear.ts"

NodeRuntime.runMain(
  runGauntlet(process.argv.slice(2)).pipe(
    Effect.map((exitCode) => {
      process.exitCode = exitCode
    }),
    Effect.provide(livePiLayer),
    Effect.provide(Linear.Default),
    Effect.provide(liveGitHubLayer),
    Effect.provide(NodeServices.layer),
  ),
)
