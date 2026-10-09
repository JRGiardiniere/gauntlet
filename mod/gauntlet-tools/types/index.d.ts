// gauntlet-tools' state contract: what it saw of each of the Mod's agents, one
// append-only log per agent id, which the Mod's engine reads in order. An
// emit carries the verdict the agent was answered with; a message_end is one
// response, with Claude's own stop reason and what its request cost.
// Self-contained, as a plugin contract must be.
export type GauntletToolsJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<GauntletToolsJson>
  | { readonly [key: string]: GauntletToolsJson }

export type GauntletToolsEvent =
  | { readonly type: "tool_start"; readonly toolName: string; readonly args: GauntletToolsJson }
  | { readonly type: "tool_end"; readonly toolName: string; readonly isError: boolean; readonly detail?: string }
  | { readonly type: "emit"; readonly args: GauntletToolsJson; readonly accepted: boolean }
  | {
    readonly type: "message_end"
    readonly stopReason: string
    readonly usage: {
      readonly input_tokens: number
      readonly output_tokens: number
      readonly cache_read_input_tokens: number
      readonly cache_creation_input_tokens: number
      readonly model: string
    } | null
  }

declare module "claude-code" {
  interface PluginState {
    "gauntlet-tools": { events: StateFamily<ReadonlyArray<GauntletToolsEvent>> }
  }
}
