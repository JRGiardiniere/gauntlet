// gc-cli's state contract: the agent registry gc-cli-tools reads to serve
// gc-cli's agents (their emit tool and the snapshot their reads are fenced
// to), one member per agent id. Self-contained, as a plugin contract must be.
export type GcCliAgent = {
  readonly invocation: string
  readonly emitTool: string
  readonly root: string
}

declare module "claude-code" {
  interface PluginState {
    "gc-cli": { agents: StateFamily<GcCliAgent> }
  }
}
