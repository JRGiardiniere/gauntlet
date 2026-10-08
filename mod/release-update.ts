import { isNewer } from "../src/cli/update-check.ts"

// The mod's update notice, as the CLI's: the newest release tag (`vX.Y.Z`, the
// tags the release workflow builds) on origin, when the checkout sits on an
// older one. `current` is `git describe --exact-match` of the checkout (a dev
// checkout on a branch has none), `remote` is `git ls-remote --tags` output.
export const releaseNotice = (current: string, remote: string): string | undefined => {
  const installed = current.trim().replace(/^v/, "")
  const newest = remote
    .split("\n")
    .map((line) => line.replace(/^.*refs\/tags\/v/, "").trim())
    .reduce((best, version) => (isNewer(version, best) ? version : best), installed)
  return newest === installed || !isNewer(newest, installed)
    ? undefined
    : `Gauntlet v${newest} is available (this is v${installed}): ask Claude to update Gauntlet, then restart Claude Code.`
}
