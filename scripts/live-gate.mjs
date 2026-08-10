#!/usr/bin/env node
// The live gate's runMain boundary (mirrors bin/gauntlet.mjs). Everything
// below stays Effect-native; the exit code is decided inside runLiveGate.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { runLiveGate } from "../src/harness/live-gate.ts"

NodeRuntime.runMain(
  runLiveGate(process.argv.slice(2)).pipe(
    Effect.map((exitCode) => {
      process.exitCode = exitCode
    }),
    Effect.provide(NodeServices.layer),
  ),
  { disablePrettyLogger: true },
)
