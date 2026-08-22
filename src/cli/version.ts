import { isCompiledBinary } from "../content/lens.ts"

// The release identity of this build. scripts/bundle.ts always injects
// GAUNTLET_VERSION as a compile-time define — the release workflow passes the
// tag, and an untagged local bundle gets the dev sentinel — so every compiled
// binary has the identifier. A source checkout has no bundler pass and never
// evaluates it (the branch guards the reference), reporting the sentinel,
// which never parses as a release version and therefore never triggers an
// update notice.
declare const GAUNTLET_VERSION: string

export const gauntletVersion: string = isCompiledBinary
  ? GAUNTLET_VERSION
  : "0.0.0-dev"
