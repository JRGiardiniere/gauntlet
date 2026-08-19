import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import { chompLine, runGit } from "./git.ts"

// The directory Gauntlet was invoked from. Review targeting and effective
// project-local Lens discovery share this ambient input; tests override it
// instead of changing the process working directory.
export const InvocationDirectory = Context.Reference<string>(
  "gauntlet/InvocationDirectory",
  { defaultValue: () => globalThis.process.cwd() },
)

// Config remains useful outside a repository, but inside one its project-local
// Lens Catalog must match review targeting even when invoked from a subdirectory.
export const resolveInvocationProjectRoot = Effect.fn(
  "gauntlet.target.resolve_invocation_project_root",
)(function* () {
  const directory = yield* InvocationDirectory
  return yield* runGit(directory, ["rev-parse", "--show-toplevel"]).pipe(
    Effect.map(chompLine),
    Effect.catchTag("GitCommandError", () => Effect.succeed(directory)),
  )
})
