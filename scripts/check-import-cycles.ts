// The import-cycle gate's runMain boundary: madge --circular over src, its
// report inherited so the terminal shows cycles directly.
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as ChildProcess from "effect/unstable/process/ChildProcess"

const repoRoot = `${import.meta.dirname}/..`

const program = Effect.scoped(
  Effect.gen(function* () {
    const handle = yield* ChildProcess.make(
      process.execPath,
      [
        `${repoRoot}/node_modules/madge/bin/cli.js`,
        "--circular",
        "--extensions",
        "ts",
        "src",
      ],
      { cwd: repoRoot, stdout: "inherit", stderr: "inherit" },
    )
    process.exitCode = yield* handle.exitCode
  }),
)

NodeRuntime.runMain(program.pipe(Effect.provide(NodeServices.layer)))
