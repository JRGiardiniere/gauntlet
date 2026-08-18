import * as Context from "effect/Context"

// The directory Gauntlet was invoked from. Review targeting and effective
// project-local Lens discovery share this ambient input; tests override it
// instead of changing the process working directory.
export const InvocationDirectory = Context.Reference<string>(
  "gauntlet/InvocationDirectory",
  { defaultValue: () => globalThis.process.cwd() },
)
