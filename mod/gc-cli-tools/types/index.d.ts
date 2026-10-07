// gc-cli-tools' state contract: what it saw of each gc-cli agent, one
// append-only log per agent id, which gc-cli's engine reads in order. An
// emit carries the verdict the agent was answered with. Self-contained, as
// a plugin contract must be.
export type GcCliToolsJson =
  | null
  | boolean
  | number
  | string
  | ReadonlyArray<GcCliToolsJson>
  | { readonly [key: string]: GcCliToolsJson }

export type GcCliToolsEvent =
  | { readonly type: "tool_start"; readonly toolName: string; readonly args: GcCliToolsJson }
  | { readonly type: "tool_end"; readonly toolName: string; readonly isError: boolean; readonly detail?: string }
  | { readonly type: "emit"; readonly args: GcCliToolsJson; readonly accepted: boolean }

declare module "claude-code" {
  interface PluginState {
    "gc-cli-tools": { events: StateFamily<ReadonlyArray<GcCliToolsEvent>> }
  }
}
