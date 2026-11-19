#!/usr/bin/env bun
// The single runMain boundary. Everything below stays Effect-native; the
// exit-code contract is decided inside runGauntlet before this crossing.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import { runGauntlet } from "../src/cli/main.ts"
import { liveGitHubLayer } from "../src/github/github.ts"
import { hostHarnessLayer } from "../src/harness/host-harness.ts"
import { liveHostLayer } from "../src/host/live-host.ts"

NodeRuntime.runMain(
  runGauntlet(process.argv.slice(2)).pipe(
    Effect.map((exitCode) => {
      process.exitCode = exitCode
    }),
    // oxlint-disable-next-line effecttsgo/strict-effect-provide -- the single runMain boundary
    Effect.provide(
      Layer.mergeAll(liveGitHubLayer, hostHarnessLayer).pipe(
        Layer.provideMerge(liveHostLayer()),
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  ),
)
