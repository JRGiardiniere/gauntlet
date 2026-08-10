#!/usr/bin/env node
// The single runMain boundary. Everything below stays Effect-native; the
// exit-code contract is decided inside runGauntlet before this crossing.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import { runGauntlet } from "../src/cli/main.ts"

NodeRuntime.runMain(
  runGauntlet(process.argv.slice(2)).pipe(
    Effect.map((exitCode) => {
      process.exitCode = exitCode
    }),
    Effect.provide(NodeServices.layer),
  ),
  { disablePrettyLogger: true },
)
