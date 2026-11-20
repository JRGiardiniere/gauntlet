#!/usr/bin/env bun
// The live gate's runMain boundary (mirrors bin/gauntlet.ts). Everything
// below stays Effect-native; the exit code is decided inside runLiveGate.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { hostHarnessLayer } from "../src/harness/host-harness.ts"
import { runLiveGate } from "../src/harness/live-gate.ts"
import { liveHostLayer } from "../src/host/live-host.ts"

NodeRuntime.runMain(
  runLiveGate(process.argv.slice(2)).pipe(
    Effect.map((exitCode) => {
      process.exitCode = exitCode
    }),
    Effect.provide(
      hostHarnessLayer.pipe(
        Layer.provideMerge(liveHostLayer()),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
)
