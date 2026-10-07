import { describe, expect, it } from "@effect/vitest"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as PlatformError from "effect/PlatformError"
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner"
import { GitHub, liveGitHubLayer } from "./github.ts"

// A machine without gh: spawning it fails the way Node reports ENOENT.
const missingGh = Layer.succeed(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.make(() =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "NotFound",
        module: "ChildProcess",
        method: "spawn",
        pathOrDescriptor: "gh pr view 7",
      }),
    )
  ),
)

describe("GitHub", () => {
  it.effect("says to install gh when it is missing", () =>
    Effect.gen(function* () {
      const github = yield* GitHub
      const failure = yield* Effect.flip(github.viewPullRequest("/repo", 7))
      expect(failure.reason).toContain("gh is not installed")
    }).pipe(
      Effect.provide(
        liveGitHubLayer.pipe(
          Layer.provide(Layer.merge(NodeServices.layer, missingGh)),
        ),
      ),
    ))
})
