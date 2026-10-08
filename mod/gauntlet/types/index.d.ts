// The gauntlet plugin's state contract: the agent registry gauntlet-tools
// reads to serve its agents (their emit tool and the snapshot their reads are
// fenced to), one member per agent id. Self-contained, as a plugin contract must be.
export type GauntletAgent = {
  readonly invocation: string
  readonly emitTool: string
  readonly root: string
}

declare module "claude-code" {
  interface PluginState {
    "gauntlet": { agents: StateFamily<GauntletAgent> }
  }
}
