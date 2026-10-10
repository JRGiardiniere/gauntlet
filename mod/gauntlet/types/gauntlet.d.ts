// The gauntlet plugin's contract: the session values its strip's draws
// subscribe to, each bumped by the hooks module's clock. The terminal's band
// reads `tick`, bumped every half second while a review runs, for its clock
// and pulse; the others read `drawn`, bumped only when what the strip shows
// changes, since they reload the strip's drawing on every redraw.

// How many times the clock has bumped the value.
export type GauntletRedraws = number

declare module "claude-code" {
  interface PluginState {
    gauntlet: {
      tick: GauntletRedraws
      drawn: GauntletRedraws
    }
  }
}
