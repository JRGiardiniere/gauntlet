// The beta's update notice, as the CLI's `gauntlet upgrade` notice: the
// newest `gc-cli-beta.N` tag on origin, when the checkout sits on an older one.
// `current` is `git describe --exact-match` of the checkout (a dev checkout on a
// branch has none), `remote` is `git ls-remote --tags` output.
const betaNumber = (tag: string): number | undefined => {
  const match = /^gc-cli-beta\.(\d+)$/.exec(tag.trim())
  return match === null ? undefined : Number(match[1])
}

export const betaNotice = (current: string, remote: string): string | undefined => {
  const installed = betaNumber(current)
  if (installed === undefined) return undefined
  const newest = Math.max(...remote.split("\n").map((line) => betaNumber(line.replace(/^.*refs\/tags\//, "")) ?? 0))
  return newest > installed
    ? `gc-cli-beta.${String(newest)} is available (this is gc-cli-beta.${String(installed)}): ask Claude to update the gc-cli plugin, then restart Claude Code.`
    : undefined
}
