// Claude Code's declarations (mod/types/claude-code-tools, written by
// `bun run mod-types`) list the main loop's built-in tools, which lack Grep
// and Glob; subagents still get both (gc-native finders called Grep in runs
// on 2026-10-05). The mod fences them, so their inputs are declared here the
// way the engine's own file merges tool inputs.
declare module "claude-code" {
  interface BuiltinToolInputs {
    Grep: {
      pattern: string
      path?: string
      glob?: string
      output_mode?: "content" | "files_with_matches" | "count"
    }
    Glob: {
      pattern: string
      path?: string
    }
  }
}
export {}
