import * as Effect from "effect/Effect"

// The Claude Code session variables a calling Claude Code session sets. The
// `claude` children OpenCode spawns inherit Gauntlet's environment, and these
// would tie them to that session. A named list, not a `CLAUDE*` glob: the
// login variables (CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, the Bedrock
// and Vertex switches) are how the child finds its login.
export const CLAUDE_SESSION_VARIABLES = [
  "CLAUDECODE",
  "CLAUDE_AGENT_SDK_VERSION",
  "CLAUDE_CODE_AUTO_COMPACT_WINDOW",
  "CLAUDE_CODE_CHILD_NOTES_DIR",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_SESSION_ATTENDED",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_TMPDIR",
  "CLAUDE_EFFORT",
  "CLAUDE_PID",
] as const

// OPENCODE_FLAGS would switch on the person's experimental OpenCode flags.
const HOST_SCRUBBED = [...CLAUDE_SESSION_VARIABLES, "OPENCODE_FLAGS"]

// Runs before the Host loads, on Gauntlet's own environment, which OpenCode
// and its `claude` children read.
export const scrubHostEnvironment = (environment: Record<string, string | undefined>) =>
  Effect.sync(() => {
    for (const name of HOST_SCRUBBED) Reflect.deleteProperty(environment, name)
  })
