// gauntlet-tools' state contract: what it saw of each of the Mod's agents, one
// append-only log per agent id, which the Mod's engine reads in order. An
// emit carries the verdict the agent was answered with. Self-contained, as
// a plugin contract must be.
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

declare module "claude-code" {
  interface PluginState {
    "gauntlet-tools": { events: StateFamily<ReadonlyArray<GauntletToolsEvent>> }
  }
}
